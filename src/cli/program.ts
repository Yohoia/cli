import { open, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { z } from "zod";
import manifest from "../../package.json" with { type: "json" };
import { resolveContentRoot } from "../adapters/project.js";
import { createFileArticleStore } from "../adapters/article-store.js";
import {
  articleIdSchema,
  articleRevisionSchema,
  articleStatusSchema,
  articleTitleSchema,
  articleTagsSchema,
  createArticleService,
} from "../core/articles.js";
import type {
  Article,
  ArticleChanges,
  ArticleDeletion,
  ArticleDeletionPreview,
  ArticleSummary,
  ArticleUpdate,
} from "../core/articles.js";
import { AppError } from "../core/errors.js";

const optionsSchema = z.object({
  project: z.string().optional(),
  json: z.boolean().default(false),
  status: articleStatusSchema.optional(),
});
const updateOptionsSchema = optionsSchema
  .extend({
    title: articleTitleSchema.optional(),
    description: z.string().optional(),
    tag: articleTagsSchema.optional(),
    clearTags: z.boolean().default(false),
    bodyFile: z.string().min(1).optional(),
    ifMatch: articleRevisionSchema.optional(),
  })
  .refine(
    (options) =>
      options.title !== undefined ||
      options.bodyFile !== undefined ||
      options.description !== undefined ||
      options.tag !== undefined ||
      options.clearTags ||
      options.status !== undefined,
    "至少提供一项文章内容更新",
  )
  .refine(
    (options) => !(options.clearTags && options.tag !== undefined),
    "--tag 与 --clear-tags 不能同时使用",
  );

async function readBodyInput(path: string, signal: AbortSignal) {
  const sourcePath = await realpath(resolve(process.cwd(), path));
  if (!(await stat(sourcePath)).isFile()) {
    throw new AppError({
      code: "INVALID_ARGUMENT",
      message: `正文输入不是普通文件：${path}`,
      exitCode: 2,
    });
  }
  const file = await open(sourcePath, "r");
  try {
    if (!(await file.stat()).isFile()) {
      throw new AppError({
        code: "INVALID_ARGUMENT",
        message: `正文输入不是普通文件：${path}`,
        exitCode: 2,
      });
    }
    const bytes = await file.readFile({ signal });
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) {
      throw new AppError({
        code: "INVALID_ARGUMENT",
        message: `正文输入不是有效 UTF-8：${path}`,
        exitCode: 2,
      });
    }
    return {
      kind: "body",
      content,
      sourcePath,
    } satisfies ArticleChanges[number];
  } finally {
    await file.close();
  }
}
const createOptionsSchema = optionsSchema.extend({
  title: articleTitleSchema,
  description: z.string(),
  publishedAt: z.string().transform((value, ctx) => {
    const match =
      /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2}))?$/.exec(
        value,
      );
    const year = Number(match?.[1]);
    const month = Number(match?.[2]);
    const day = Number(match?.[3]);
    const calendar = new Date(0);
    calendar.setUTCFullYear(year, month - 1, day);
    calendar.setUTCHours(0, 0, 0, 0);
    const zone = match?.[8];
    const parsed = new Date(value);
    if (
      !match ||
      calendar.getUTCFullYear() !== year ||
      calendar.getUTCMonth() !== month - 1 ||
      calendar.getUTCDate() !== day ||
      (match[4] !== undefined &&
        (Number(match[4]) > 23 ||
          Number(match[5]) > 59 ||
          Number(match[6]) > 59)) ||
      (zone !== undefined &&
        zone !== "Z" &&
        (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) ||
      !Number.isFinite(parsed.getTime())
    ) {
      ctx.addIssue({
        code: "custom",
        message: "发布日期必须为有效 ISO 日期或带时区时间",
      });
      return z.NEVER;
    }
    return parsed.toISOString();
  }),
  format: z.enum(["md", "mdx"]).default("md"),
  bodyFile: z.string().min(1).optional(),
  tag: articleTagsSchema.default([]),
});
const deleteOptionsSchema = optionsSchema
  .extend({
    dryRun: z.boolean().default(false),
    yes: z.boolean().default(false),
    ifMatch: articleRevisionSchema.optional(),
  })
  .refine((options) => options.dryRun || options.yes, "实际删除必须提供 --yes");
export type CommandResult =
  | { kind: "list"; data: { items: ArticleSummary[] } }
  | { kind: "show"; data: Article }
  | { kind: "create"; data: Article }
  | { kind: "delete-preview"; data: ArticleDeletionPreview }
  | { kind: "delete"; data: ArticleDeletion }
  | { kind: "update"; data: ArticleUpdate };

export async function runProgram({
  argv,
  signal,
}: {
  argv: string[];
  signal: AbortSignal;
}): Promise<CommandResult | undefined> {
  let result: CommandResult | undefined;
  async function articlesForProject(project: string | undefined) {
    const root = await resolveContentRoot({ cwd: process.cwd(), project });
    return createArticleService(createFileArticleStore({ root, signal }));
  }
  const program = new Command()
    .name("yoho")
    .description("管理本地博客文章")
    .version(manifest.version)
    .option("--project <path>", "博客项目路径")
    .option("--json", "输出 JSON 结果")
    .configureOutput({ writeErr: () => undefined })
    .exitOverride();
  const blog = program.command("blog").description("管理博客文章");
  blog
    .command("list")
    .description("列出文章")
    .option("--status <status>", "按 draft、published 或 archived 状态筛选")
    .action(async (_options: unknown, command: Command) => {
      const options = optionsSchema.parse(command.optsWithGlobals());
      const service = await articlesForProject(options.project);
      result = {
        kind: "list",
        data: { items: await service.list(options.status) },
      };
    });
  blog
    .command("show")
    .description("查看完整文章")
    .argument("<id>", "文章标识")
    .action(async (rawId: unknown, _options: unknown, command: Command) => {
      const id = articleIdSchema.parse(rawId);
      const options = optionsSchema.parse(command.optsWithGlobals());
      const service = await articlesForProject(options.project);
      result = { kind: "show", data: await service.show({ id }) };
    });
  blog
    .command("create")
    .description("创建草稿文章")
    .argument("<id>", "文章标识")
    .requiredOption("--title <title>", "标题")
    .requiredOption("--description <description>", "描述，允许空字符串")
    .requiredOption("--published-at <date>", "发布日期或带时区时间")
    .option("--format <format>", "md 或 mdx")
    .option("--body-file <path>", "UTF-8 正文输入文件")
    .option(
      "--tag <tag>",
      "标签，可重复指定",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .action(async (rawId: unknown, _options: unknown, command: Command) => {
      const id = articleIdSchema.parse(rawId);
      const options = createOptionsSchema.parse(command.optsWithGlobals());
      const content =
        options.bodyFile === undefined
          ? ""
          : (await readBodyInput(options.bodyFile, signal)).content;
      const service = await articlesForProject(options.project);
      result = {
        kind: "create",
        data: await service.create({
          id,
          title: options.title,
          description: options.description,
          publishedAt: options.publishedAt,
          format: options.format,
          content,
          tags: options.tag,
        }),
      };
    });
  blog
    .command("delete")
    .description("预览或删除文章")
    .argument("<id>", "文章标识")
    .option("--dry-run", "只读预览，不删除文章")
    .option("--yes", "显式授权；与 --dry-run 同时提供时仍只预览")
    .option("--if-match <revision>", "仅当文章版本匹配时预览或删除")
    .action(async (rawId: unknown, _options: unknown, command: Command) => {
      const id = articleIdSchema.parse(rawId);
      const options = deleteOptionsSchema.parse(command.optsWithGlobals());
      const service = await articlesForProject(options.project);
      const request = {
        id,
        condition:
          options.ifMatch === undefined
            ? { kind: "any" }
            : { kind: "matches", revision: options.ifMatch },
      } satisfies Parameters<typeof service.previewDelete>[0];
      result = options.dryRun
        ? { kind: "delete-preview", data: await service.previewDelete(request) }
        : { kind: "delete", data: await service.delete(request) };
    });
  blog
    .command("update")
    .description("修改文章标题、正文、描述、标签或状态")
    .argument("<id>", "文章标识")
    .option("--title <title>", "新标题")
    .option("--description <description>", "新描述，允许空字符串")
    .option(
      "--tag <tag>",
      "替换标签，可重复指定",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--clear-tags", "清空全部标签")
    .option("--body-file <path>", "UTF-8 正文输入文件")
    .option("--status <status>", "设为 draft、published 或 archived")
    .option("--if-match <revision>", "仅当文章版本匹配时更新")
    .action(async (rawId: unknown, _options: unknown, command: Command) => {
      const id = articleIdSchema.parse(rawId);
      const options = updateOptionsSchema.parse(command.optsWithGlobals());
      const requested: ArticleChanges[number][] = [];
      if (options.title !== undefined)
        requested.push({ kind: "title", title: options.title });
      if (options.bodyFile !== undefined)
        requested.push(await readBodyInput(options.bodyFile, signal));
      if (options.description !== undefined)
        requested.push({
          kind: "description",
          description: options.description,
        });
      if (options.tag !== undefined || options.clearTags)
        requested.push({ kind: "tags", tags: options.tag ?? [] });
      if (options.status !== undefined)
        requested.push({ kind: "status", status: options.status });
      const [first, ...rest] = requested;
      if (first === undefined) {
        throw new AppError({
          code: "INVALID_ARGUMENT",
          message: "至少提供一项文章内容更新",
          exitCode: 2,
        });
      }
      const changes: ArticleChanges = [first, ...rest];
      const service = await articlesForProject(options.project);
      result = {
        kind: "update",
        data: await service.update({
          id,
          changes,
          condition:
            options.ifMatch === undefined
              ? { kind: "any" }
              : { kind: "matches", revision: options.ifMatch },
        }),
      };
    });
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return undefined;
      throw new AppError({
        code: "INVALID_ARGUMENT",
        message: error.message,
        exitCode: 2,
      });
    }
    throw error;
  }
  return result;
}

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
  createArticleService,
} from "../core/articles.js";
import type {
  Article,
  ArticleChanges,
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
    bodyFile: z.string().min(1).optional(),
    ifMatch: articleRevisionSchema.optional(),
  })
  .refine(
    (options) => options.title !== undefined || options.bodyFile !== undefined,
    "至少提供标题或正文更新",
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
export type CommandResult =
  | { kind: "list"; data: { items: ArticleSummary[] } }
  | { kind: "show"; data: Article }
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
    .command("update")
    .description("修改文章标题或正文")
    .argument("<id>", "文章标识")
    .option("--title <title>", "新标题")
    .option("--body-file <path>", "UTF-8 正文输入文件")
    .option("--if-match <revision>", "仅当文章版本匹配时更新")
    .action(async (rawId: unknown, _options: unknown, command: Command) => {
      const id = articleIdSchema.parse(rawId);
      const options = updateOptionsSchema.parse(command.optsWithGlobals());
      let changes: ArticleChanges;
      if (options.title !== undefined) {
        changes = [{ kind: "title", title: options.title }];
        if (options.bodyFile !== undefined)
          changes.push(await readBodyInput(options.bodyFile, signal));
      } else if (options.bodyFile !== undefined) {
        changes = [await readBodyInput(options.bodyFile, signal)];
      } else {
        throw new AppError({
          code: "INVALID_ARGUMENT",
          message: "至少提供标题或正文更新",
          exitCode: 2,
        });
      }
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

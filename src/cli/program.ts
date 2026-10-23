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
const updateOptionsSchema = optionsSchema.extend({
  title: articleTitleSchema,
  ifMatch: articleRevisionSchema.optional(),
});
const deleteOptionsSchema = optionsSchema.extend({
  dryRun: z.literal(true, "此阶段仅支持 --dry-run 删除预览"),
  yes: z.boolean().optional(),
  ifMatch: articleRevisionSchema.optional(),
});
export type CommandResult =
  | { kind: "list"; data: { items: ArticleSummary[] } }
  | { kind: "show"; data: Article }
  | { kind: "delete-preview"; data: ArticleDeletionPreview }
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
    .command("delete")
    .description("预览文章删除")
    .argument("<id>", "文章标识")
    .option("--dry-run", "只读预览，不删除文章")
    .option("--yes", "显式授权；与 --dry-run 同时提供时仍只预览")
    .option("--if-match <revision>", "仅当文章版本匹配时预览")
    .action(async (rawId: unknown, _options: unknown, command: Command) => {
      const id = articleIdSchema.parse(rawId);
      const options = deleteOptionsSchema.parse(command.optsWithGlobals());
      const service = await articlesForProject(options.project);
      result = {
        kind: "delete-preview",
        data: await service.previewDelete({
          id,
          condition:
            options.ifMatch === undefined
              ? { kind: "any" }
              : { kind: "matches", revision: options.ifMatch },
        }),
      };
    });
  blog
    .command("update")
    .description("修改文章标题")
    .argument("<id>", "文章标识")
    .requiredOption("--title <title>", "新标题")
    .option("--if-match <revision>", "仅当文章版本匹配时更新")
    .action(async (rawId: unknown, _options: unknown, command: Command) => {
      const id = articleIdSchema.parse(rawId);
      const options = updateOptionsSchema.parse(command.optsWithGlobals());
      const service = await articlesForProject(options.project);
      result = {
        kind: "update",
        data: await service.update({
          id,
          title: options.title,
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

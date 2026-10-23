import { Command, CommanderError } from "commander";
import { z } from "zod";
import manifest from "../../package.json" with { type: "json" };
import { resolveContentRoot } from "../adapters/project.js";
import { createFileArticleStore } from "../adapters/article-store.js";
import { articleIdSchema, articleStatusSchema, createArticleService } from "../core/articles.js";
import type { Article, ArticleSummary } from "../core/articles.js";
import { AppError } from "../core/errors.js";

const optionsSchema = z.object({ project: z.string().optional(), json: z.boolean().default(false), status: articleStatusSchema.optional() });
export type CommandResult = { kind: "list"; data: { items: ArticleSummary[] } } | { kind: "show"; data: Article };

export async function runProgram({ argv, signal }: { argv: string[]; signal: AbortSignal }): Promise<CommandResult | undefined> {
  let result: CommandResult | undefined;
  const program = new Command()
    .name("yoho")
    .description("管理本地博客文章")
    .version(manifest.version)
    .option("--project <path>", "博客项目路径")
    .option("--json", "输出 JSON 结果")
    .configureOutput({ writeErr: () => undefined })
    .exitOverride();
  const blog = program.command("blog").description("管理博客文章");
  blog.command("list").description("列出文章")
    .option("--status <status>", "按 draft、published 或 archived 状态筛选")
    .action(async (_options: unknown, command: Command) => {
      const options = optionsSchema.parse(command.optsWithGlobals());
      const root = await resolveContentRoot({ cwd: process.cwd(), project: options.project });
      const service = createArticleService(createFileArticleStore({ root, signal }));
      result = { kind: "list", data: { items: await service.list(options.status) } };
    });
  blog.command("show").description("查看完整文章")
    .argument("<id>", "文章标识")
    .action(async (rawId: unknown, _options: unknown, command: Command) => {
      const id = articleIdSchema.parse(rawId);
      const options = optionsSchema.parse(command.optsWithGlobals());
      const root = await resolveContentRoot({ cwd: process.cwd(), project: options.project });
      const service = createArticleService(createFileArticleStore({ root, signal }));
      result = { kind: "show", data: await service.show({ id }) };
    });
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.exitCode === 0) return undefined;
      throw new AppError({ code: "INVALID_ARGUMENT", message: error.message, exitCode: 2 });
    }
    throw error;
  }
  return result;
}

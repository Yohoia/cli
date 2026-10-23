import { Command, CommanderError } from "commander";
import { z } from "zod";
import manifest from "../../package.json" with { type: "json" };
import { AppError } from "../core/errors.js";
import { login, authStatus, logout } from "../remote/auth.js";
import { resolveServer, saveServer } from "../remote/config.js";
import { requireToken } from "../remote/credentials.js";
import {
  RemoteClient,
  remoteResponse,
  remoteErrorMessage,
} from "../remote/http.js";
import { randomUUID } from "node:crypto";
import { uploadImages } from "../remote/upload.js";
import { readDocument } from "../remote/document.js";
import {
  saveOperation,
  queryOperation,
  performOperation,
  readOperation,
  type OperationRecord,
} from "../remote/operations.js";
import { articleSchema, listSchema } from "../remote/models.js";

const optionsSchema = z.object({
  server: z.string().optional(),
  json: z.boolean().default(false),
});
export type CommandResult =
  | { kind: "list"; data: z.infer<typeof listSchema> }
  | { kind: "show"; data: z.infer<typeof articleSchema> }
  | { kind: "write"; data: Awaited<ReturnType<typeof performOperation>> }
  | { kind: "operation"; data: Awaited<ReturnType<typeof queryOperation>> }
  | {
      kind: "auth";
      data:
        | Awaited<ReturnType<typeof authStatus>>
        | Awaited<ReturnType<typeof logout>>;
    }
  | { kind: "config"; data: { server: string } }
  | {
      kind: "delete-preview";
      data: Pick<
        z.infer<typeof articleSchema>,
        "id" | "title" | "status" | "revision"
      > & { deleted: false };
    };
export async function runProgram({
  argv,
  signal,
}: {
  argv: string[];
  signal: AbortSignal;
}): Promise<CommandResult | undefined> {
  const optionArguments = argv.slice(
    0,
    argv.indexOf("--") === -1 ? undefined : argv.indexOf("--"),
  );
  if (
    optionArguments.some(
      (argument) =>
        argument === "--project" || argument.startsWith("--project="),
    ) ||
    (optionArguments[0] === "blog" && optionArguments[1] === "update")
  ) {
    throw new AppError({
      code: "LOCAL_MODE_REMOVED",
      message:
        "本地文章管理已迁移为远程 PageHush API。使用 yoho blog list 查询、yoho blog create <path.md> 上传草稿；修改已有文章请使用 PageHush 网页。",
      exitCode: 2,
    });
  }
  let result: CommandResult | undefined;
  async function client(command: Command) {
    const options = optionsSchema.parse(command.optsWithGlobals());
    const server = await resolveServer(options.server);
    return new RemoteClient(server, signal, await requireToken(server));
  }
  const program = new Command()
    .name("yoho")
    .description("通过 PageHush API 管理远程博客文章")
    .version(manifest.version)
    .option("--server <url>", "PageHush 服务地址")
    .option("--json", "输出 JSON 结果")
    .configureOutput({ writeErr: () => undefined })
    .exitOverride();
  const auth = program.command("auth").description("设备授权管理");
  auth
    .command("login")
    .description("通过网页批准此 CLI 设备")
    .option("--no-browser", "手动打开网页")
    .action(async (_options: unknown, command: Command) => {
      const options = optionsSchema
        .extend({ browser: z.boolean() })
        .parse(command.optsWithGlobals());
      const server = await resolveServer(options.server);
      result = {
        kind: "auth",
        data: await login(new RemoteClient(server, signal), {
          openBrowser: options.browser,
        }),
      };
    });
  for (const [name, handler] of [
    ["status", authStatus],
    ["logout", logout],
  ] satisfies [string, typeof authStatus | typeof logout][]) {
    auth.command(name).action(async (_options: unknown, command: Command) => {
      result = { kind: "auth", data: await handler(await client(command)) };
    });
  }
  program
    .command("config")
    .description("设置单一默认服务")
    .command("server")
    .argument("<url>")
    .action(async (url: string) => {
      result = { kind: "config", data: { server: await saveServer(url) } };
    });
  const blog = program.command("blog").description("管理远程文章");
  blog
    .command("update [id]")
    .description("已移除：请在 PageHush 网页修改已有文章")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      throw new AppError({
        code: "LOCAL_MODE_REMOVED",
        message:
          "CLI 已迁移为远程管理，修改已有文章请使用 PageHush 网页；新增使用 yoho blog create <path.md>",
        exitCode: 2,
      });
    });
  blog
    .command("list")
    .description("列出未删除的远程文章")
    .option("--status <status>", "按 draft 或 published 筛选")
    .option("--keyword <text>", "按标题关键词筛选")
    .option("--page <number>", "页码，从 1 开始", "1")
    .option("--page-size <number>", "每页数量，默认 20", "20")
    .action(async (_options: unknown, command: Command) => {
      const options = optionsSchema
        .extend({
          status: z.enum(["draft", "published"]).optional(),
          keyword: z.string().optional(),
          page: z.coerce.number().int().min(1),
          pageSize: z.coerce.number().int().min(1).max(200),
        })
        .parse(command.optsWithGlobals());
      const query = new URLSearchParams({
        page: String(options.page),
        pageSize: String(options.pageSize),
      });
      if (options.status) query.set("status", options.status);
      if (options.keyword) query.set("q", options.keyword);
      result = {
        kind: "list",
        data: remoteResponse(
          listSchema,
          await (await client(command)).request(`/v1/cli/articles?${query}`),
        ),
      };
    });
  blog
    .command("show")
    .description("查看完整远程文章及版本")
    .argument("<id>", "UUID 或完整短 ID")
    .action(async (id: string, _options: unknown, command: Command) => {
      result = {
        kind: "show",
        data: remoteResponse(
          articleSchema,
          await (
            await client(command)
          ).request(`/v1/cli/articles/${encodeURIComponent(id)}`),
        ),
      };
    });
  blog
    .command("create")
    .description("从单个 Markdown 文件上传新草稿")
    .argument("<path>", ".md 文件路径")
    .action(async (path: string, _options: unknown, command: Command) => {
      const document = await readDocument(path, signal);
      const api = await client(command);
      const record: OperationRecord = {
        requestId: randomUUID(),
        server: api.server,
        createdAt: new Date().toISOString(),
        kind: "create",
        fingerprint: document.fingerprint,
      };
      await saveOperation(record);
      result = {
        kind: "write",
        data: await performOperation(
          api,
          record,
          await uploadImages(api, record.requestId, document),
        ),
      };
    });
  blog
    .command("publish")
    .description("按指定文章版本发布")
    .argument("<id>", "UUID 或完整短 ID")
    .requiredOption("--if-match <revision>", "已查看的服务器文章版本")
    .action(async (id: string, _options: unknown, command: Command) => {
      const { ifMatch } = optionsSchema
        .extend({ ifMatch: z.string().min(1) })
        .parse(command.optsWithGlobals());
      const api = await client(command);
      const record: OperationRecord = {
        requestId: randomUUID(),
        server: api.server,
        createdAt: new Date().toISOString(),
        kind: "publish",
        id,
        revision: ifMatch,
      };
      await saveOperation(record);
      result = { kind: "write", data: await performOperation(api, record) };
    });
  blog
    .command("delete")
    .description("预览或按版本软删除文章")
    .argument("<id>")
    .option("--dry-run", "只读预览，不锁定或删除目标")
    .option("--yes", "确认执行；与 --dry-run 同时提供仍只预览")
    .option("--if-match <revision>", "已查看的服务器文章版本")
    .action(async (id: string, _options: unknown, command: Command) => {
      const options = optionsSchema
        .extend({
          dryRun: z.boolean().default(false),
          yes: z.boolean().default(false),
          ifMatch: z.string().min(1).optional(),
        })
        .parse(command.optsWithGlobals());
      if (!options.dryRun && (!options.yes || !options.ifMatch))
        throw new AppError({
          code: "INVALID_ARGUMENT",
          message:
            "实际软删除必须同时提供 --yes 和 --if-match；可先用 --dry-run 预览",
          exitCode: 2,
        });
      const api = await client(command);
      if (options.dryRun) {
        const article = remoteResponse(
          articleSchema,
          await api.request(`/v1/cli/articles/${encodeURIComponent(id)}`),
        );
        result = {
          kind: "delete-preview",
          data: {
            id: article.id,
            title: article.title,
            status: article.status,
            revision: article.revision,
            deleted: false,
          },
        };
        return;
      }
      if (options.ifMatch === undefined)
        throw new AppError({
          code: "INVALID_ARGUMENT",
          message: "缺少文章版本",
          exitCode: 2,
        });
      const record: OperationRecord = {
        requestId: randomUUID(),
        server: api.server,
        createdAt: new Date().toISOString(),
        kind: "delete",
        id,
        revision: options.ifMatch,
      };
      await saveOperation(record);
      result = { kind: "write", data: await performOperation(api, record) };
    });
  blog
    .command("operation")
    .description("按请求编号查询远程写入结果")
    .argument("<request-id>")
    .action(async (id: string, _options: unknown, command: Command) => {
      result = {
        kind: "operation",
        data: await queryOperation(await client(command), id),
      };
    });
  blog
    .command("resume")
    .description("恢复已有操作；新增文章必须再次提供原文档路径")
    .argument("<request-id>")
    .argument("[path]", "原 .md 文档路径")
    .action(
      async (
        id: string,
        path: string | undefined,
        _options: unknown,
        command: Command,
      ) => {
        const api = await client(command);
        const record = await readOperation(api.server, id);
        const existing = await queryOperation(api, id).catch((error) => {
          if (error instanceof AppError && error.code === "OPERATION_UNKNOWN")
            return undefined;
          throw error;
        });
        if (existing?.status === "succeeded") {
          result = {
            kind: "write",
            data: { requestId: existing.requestId, ...existing.result },
          };
          return;
        }
        if (existing?.status === "failed")
          throw new AppError({
            code: existing.error.code.toUpperCase(),
            message: remoteErrorMessage(
              existing.error.code.toUpperCase(),
              existing.error.message,
            ),
            exitCode: 3,
          });
        if (record.kind !== "create") {
          result = { kind: "write", data: await performOperation(api, record) };
          return;
        }
        if (!path)
          throw new AppError({
            code: "INVALID_ARGUMENT",
            message: "恢复文章上传必须提供原 .md 文件路径",
            exitCode: 2,
          });
        const document = await readDocument(path, signal);
        if (document.fingerprint !== record.fingerprint)
          throw new AppError({
            code: "REQUEST_CONFLICT",
            message: "源文档或图片已变化，不能使用原请求编号恢复",
            exitCode: 3,
          });
        result = {
          kind: "write",
          data: await performOperation(
            api,
            record,
            await uploadImages(api, record.requestId, document),
          ),
        };
      },
    );
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

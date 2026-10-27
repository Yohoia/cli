import type { Command } from "commander";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { AppError } from "../../core/errors.js";
import { remoteResponse, remoteErrorMessage } from "../../remote/http.js";
import { readDocument } from "../../remote/document.js";
import { uploadImages } from "../../remote/upload.js";
import {
  saveOperation,
  queryOperation,
  performOperation,
  readOperation,
  type OperationRecord,
} from "../../remote/operations.js";
import { articleSchema, listSchema } from "../../remote/model.js";
import { withProgress } from "../presentation.js";
import { optionsSchema, type CommandContext } from "./context.js";
export function registerBlog(
  program: Command,
  { signal, publish, client }: CommandContext,
) {
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
      publish({
        kind: "list",
        data: remoteResponse(
          listSchema,
          await withProgress("正在读取文章列表…", async () =>
            (await client(command)).request(`/v1/cli/articles?${query}`),
          ),
        ),
      });
    });
  blog
    .command("show")
    .description("查看完整远程文章及版本")
    .argument("<id>", "UUID 或完整短 ID")
    .action(async (id: string, _options: unknown, command: Command) => {
      publish({
        kind: "show",
        data: remoteResponse(
          articleSchema,
          await (
            await client(command)
          ).request(`/v1/cli/articles/${encodeURIComponent(id)}`),
        ),
      });
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
      publish({
        kind: "write",
        data: await performOperation(
          api,
          record,
          await uploadImages(api, record.requestId, document),
        ),
      });
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
      publish({ kind: "write", data: await performOperation(api, record) });
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
        publish({
          kind: "delete-preview",
          data: {
            id: article.id,
            title: article.title,
            status: article.status,
            revision: article.revision,
            deleted: false,
          },
        });
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
      publish({ kind: "write", data: await performOperation(api, record) });
    });
  blog
    .command("operation")
    .description("按请求编号查询远程写入结果")
    .argument("<request-id>")
    .action(async (id: string, _options: unknown, command: Command) => {
      publish({
        kind: "operation",
        data: await queryOperation(await client(command), id),
      });
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
          publish({
            kind: "write",
            data: { requestId: existing.requestId, ...existing.result },
          });
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
          publish({ kind: "write", data: await performOperation(api, record) });
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
        publish({
          kind: "write",
          data: await performOperation(
            api,
            record,
            await uploadImages(api, record.requestId, document),
          ),
        });
      },
    );
}

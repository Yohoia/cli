import { z } from "zod";
import { AppError } from "../core/errors.js";

const errorSchema = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});

export function remoteResponse<T>(schema: z.ZodType<T>, response: unknown): T {
  const result = schema.safeParse(response);
  if (!result.success)
    throw new AppError({
      code: "REMOTE_PROTOCOL_ERROR",
      message: "服务端返回的数据格式无效，请核对 CLI 与 PageHush 的配套版本",
      exitCode: 5,
    });
  return result.data;
}

const recoveryGuidance: Record<string, string> = {
  UNAUTHORIZED: "设备授权已过期或被撤销，请运行 yoho auth login 重新授权",
  FORBIDDEN: "设备没有此操作权限，请在 PageHush 网页检查授权",
  REVISION_CONFLICT:
    "文章已发生变化，请用 yoho blog show <id> 重新查看并核对内容，再使用新版本操作",
  REVISION_REQUIRED:
    "缺少文章版本，请先运行 yoho blog show <id>，再提供 --if-match",
  ARTICLE_NOT_FOUND: "文章不存在或已被删除，请用 yoho blog list 核对文章标识",
  REQUEST_CONFLICT:
    "同一请求编号对应的内容或目标不一致，请查询原操作结果并核对输入",
  OPERATION_UNKNOWN:
    "服务器尚未记录此操作，请使用原请求编号和原文档恢复；无法核实时先人工检查文章",
  OPERATION_EXPIRED:
    "操作已超过结果保留期，请人工核对文章，不能重用旧编号重新执行",
};
export function remoteErrorMessage(code: string, message?: string): string {
  return (
    recoveryGuidance[code] ??
    `${message ?? `远程请求失败：${code}`}；请核对参数、服务地址及 CLI/PageHush 配套版本`
  );
}
export class RemoteClient {
  constructor(
    readonly server: string,
    readonly signal: AbortSignal,
    readonly token?: string,
  ) {}
  async request(
    path: string,
    options: {
      method?: string;
      body?: BodyInit;
      headers?: Record<string, string>;
      retry?: boolean;
    } = {},
  ): Promise<unknown> {
    const method = options.method ?? "GET";
    const attempts = method === "GET" && options.retry !== false ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await fetch(`${this.server}${path}`, {
          method,
          redirect: "error",
          signal: AbortSignal.any([this.signal, AbortSignal.timeout(10000)]),
          headers: {
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
            ...options.headers,
          },
          ...(options.body === undefined ? {} : { body: options.body }),
        });
        const body: unknown =
          response.status === 204 ? null : await response.json();
        if (!response.ok) {
          if (response.status >= 500 && attempt + 1 < attempts) continue;
          const parsed = errorSchema.safeParse(body);
          const raw = parsed.success
            ? (parsed.data.code ?? parsed.data.error ?? "remote_error")
            : "remote_error";
          const code = raw.toUpperCase();
          const exitCode =
            response.status === 401 || response.status === 403
              ? 4
              : response.status === 409 ||
                  response.status === 412 ||
                  response.status === 404 ||
                  response.status === 422
                ? 3
                : response.status === 400 || response.status === 428
                  ? 2
                  : 5;
          throw new AppError({
            code,
            message: remoteErrorMessage(
              code,
              parsed.success ? parsed.data.message : undefined,
            ),
            exitCode,
          });
        }
        return body;
      } catch (error) {
        if (error instanceof AppError || this.signal.aborted) throw error;
        if (attempt + 1 === attempts)
          throw new AppError({
            code: "NETWORK_ERROR",
            message: "无法确认服务器响应，请检查网络和服务地址",
            exitCode: 5,
          });
      }
    }
    throw new AppError({
      code: "NETWORK_ERROR",
      message: "服务器请求失败",
      exitCode: 5,
    });
  }
  json(
    path: string,
    method: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    return this.request(path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }
}

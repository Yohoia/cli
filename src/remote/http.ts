import { z } from "zod";
import { AppError } from "../core/errors.js";

const errorSchema = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});
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
            message:
              parsed.success && parsed.data.message
                ? parsed.data.message
                : `远程请求失败：${code}（HTTP ${response.status}）`,
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

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AppError, systemErrorCode } from "../core/errors.js";

export function configDirectory(): string {
  return (
    process.env.YOHO_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "yoho")
  );
}
export function normalizeServer(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError({
      code: "INVALID_ARGUMENT",
      message: "服务地址必须为完整 HTTP(S) URL",
      exitCode: 2,
    });
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  ) {
    throw new AppError({
      code: "INVALID_ARGUMENT",
      message:
        "服务地址必须为不含凭据、路径或查询参数的 HTTPS 地址（本机测试允许 HTTP）",
      exitCode: 2,
    });
  }
  return url.origin;
}
const configSchema = z.object({ server: z.string() });
export async function configuredServer(): Promise<string | undefined> {
  try {
    return configSchema.parse(
      JSON.parse(
        await readFile(join(configDirectory(), "config.json"), "utf8"),
      ),
    ).server;
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return undefined;
    throw new AppError({
      code: "CONFIG_INVALID",
      message: "配置文件不可读或格式无效，请重新设置默认服务",
      exitCode: 2,
    });
  }
}
export async function resolveServer(explicit?: string): Promise<string> {
  return normalizeServer(
    explicit ??
      process.env.YOHO_SERVER ??
      (await configuredServer()) ??
      "https://pagehush.yohoia.cn",
  );
}
export async function saveServer(raw: string): Promise<string> {
  const server = normalizeServer(raw);
  await mkdir(configDirectory(), { recursive: true, mode: 0o700 });
  await writeFile(
    join(configDirectory(), "config.json"),
    JSON.stringify({ server }) + "\n",
    { mode: 0o600 },
  );
  return server;
}

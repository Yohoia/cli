import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { AppError } from "../core/errors.js";
import { deleteToken, requireToken, saveToken } from "./credentials.js";
import { RemoteClient } from "./http.js";

const execute = promisify(execFile);
const httpUrl = z
  .url()
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol));
const deviceCodeSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: httpUrl,
  verification_uri_complete: httpUrl.optional(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive(),
});
const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
});
const sessionSchema = z.object({
  authenticated: z.literal(true),
  id: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});

function remoteResponse<T>(schema: z.ZodType<T>, response: unknown): T {
  const result = schema.safeParse(response);
  if (!result.success)
    throw new AppError({
      code: "REMOTE_PROTOCOL_ERROR",
      message: "服务端返回的授权数据无效，请核对 CLI 与 PageHush 版本",
      exitCode: 5,
    });
  return result.data;
}

function authorizationFailure(code: string, message: string) {
  return new AppError({ code, message, exitCode: 4 });
}

async function authorizedClient(client: RemoteClient) {
  return client.token
    ? client
    : new RemoteClient(
        client.server,
        client.signal,
        await requireToken(client.server),
      );
}

export async function authStatus(client: RemoteClient) {
  const authenticated = await authorizedClient(client);
  const session = remoteResponse(
    sessionSchema,
    await authenticated.request("/v1/auth/device/session"),
  );
  return {
    ...session,
    server: client.server,
    source: process.env.YOHO_TOKEN
      ? ("environment" as const)
      : ("keychain" as const),
  };
}

async function openAuthorization(url: string, signal: AbortSignal) {
  const browser =
    process.platform === "darwin"
      ? { command: "/usr/bin/open", args: [url] }
      : process.platform === "linux"
        ? { command: "xdg-open", args: [url] }
        : null;
  try {
    if (!browser) throw new Error("No browser opener on this platform");
    await execute(browser.command, browser.args, { timeout: 5_000, signal });
  } catch {
    process.stderr.write("无法自动打开浏览器，请手动访问授权地址。\n");
  }
}

export async function login(
  client: RemoteClient,
  options: { openBrowser: boolean },
) {
  if (process.env.YOHO_TOKEN) return authStatus(client);
  const code = remoteResponse(
    deviceCodeSchema,
    await client.json("/v1/auth/device/code", "POST", { name: "Yoho CLI" }),
  );
  const address = code.verification_uri_complete ?? code.verification_uri;
  process.stderr.write(
    `设备授权码：${code.user_code}\n授权地址：${address}\n请在网页确认授权，终端将等待授权结果。\n`,
  );
  if (options.openBrowser) await openAuthorization(address, client.signal);
  const deadline = Date.now() + code.expires_in * 1000;
  let interval = code.interval;
  while (Date.now() < deadline) {
    await delay(
      Math.min(interval * 1000, Math.max(0, deadline - Date.now())),
      undefined,
      { signal: client.signal },
    );
    if (Date.now() >= deadline) break;
    try {
      const token = remoteResponse(
        tokenSchema,
        await client.json("/v1/auth/device/token", "POST", {
          device_code: code.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      );
      const deviceClient = new RemoteClient(
        client.server,
        client.signal,
        token.access_token,
      );
      const state = await authStatus(deviceClient);
      try {
        await saveToken(client.server, token.access_token);
      } catch (error) {
        await deviceClient
          .request("/v1/auth/device/logout", { method: "DELETE", retry: false })
          .catch(() => undefined);
        throw error;
      }
      return state;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      if (error.code === "AUTHORIZATION_PENDING") continue;
      if (error.code === "SLOW_DOWN") {
        interval += 5;
        continue;
      }
      if (error.code === "ACCESS_DENIED")
        throw authorizationFailure(
          "ACCESS_DENIED",
          "设备授权已被拒绝；请重新运行 yoho auth login 发起授权",
        );
      if (error.code === "EXPIRED_TOKEN") break;
      throw error;
    }
  }
  throw authorizationFailure(
    "DEVICE_AUTH_EXPIRED",
    "设备授权码已过期；请重新运行 yoho auth login",
  );
}

export async function logout(client: RemoteClient) {
  const authenticated = await authorizedClient(client);
  try {
    await authenticated.request("/v1/auth/device/logout", {
      method: "DELETE",
      retry: false,
    });
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "UNAUTHORIZED")
      throw error;
    try {
      await authenticated.request("/v1/auth/device/session", { retry: false });
    } catch (statusError) {
      if (
        !(statusError instanceof AppError) ||
        statusError.code !== "UNAUTHORIZED"
      )
        throw statusError;
      await deleteToken(client.server);
      return {
        authenticated: false as const,
        server: client.server,
        revoked: true as const,
      };
    }
    throw error;
  }
  await deleteToken(client.server);
  return {
    authenticated: false as const,
    server: client.server,
    revoked: true as const,
  };
}

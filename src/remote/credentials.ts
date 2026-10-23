import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { AppError } from "../core/errors.js";

const execute = promisify(execFile);
const service = "cn.yohoia.yoho-cli";
const commandFailure = z.object({
  code: z.union([z.number(), z.string()]),
  stderr: z.string().optional(),
});

function unavailable() {
  return new AppError({
    code: "CREDENTIAL_STORE_UNAVAILABLE",
    message:
      "系统凭据存储不可用；请解锁系统凭据存储或通过 YOHO_TOKEN 提供设备令牌，不会保存明文凭据",
    exitCode: 4,
  });
}

async function keychainArgs(): Promise<string[]> {
  const keychain = process.env.YOHO_KEYCHAIN;
  if (!keychain) return [];
  if (!(await stat(keychain)).isFile()) throw unavailable();
  await execute("/usr/bin/security", ["show-keychain-info", keychain], {
    timeout: 5_000,
  });
  return [keychain];
}

function interactiveArgument(value: string) {
  if (/[\0\r\n]/.test(value)) throw unavailable();
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function secretInput(command: string, args: string[], input: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 5_000,
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(unavailable()),
    );
    child.stdin.once("error", reject);
    child.stdin.end(input);
  });
}

async function readStoredToken(server: string): Promise<string | undefined> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await execute(
        "/usr/bin/security",
        [
          "find-generic-password",
          "-s",
          service,
          "-a",
          server,
          "-w",
          ...(await keychainArgs()),
        ],
        { timeout: 5_000 },
      );
      return stdout.trim() || undefined;
    }
    if (process.platform === "linux") {
      const { stdout } = await execute(
        "secret-tool",
        ["lookup", "service", service, "server", server],
        { timeout: 5_000 },
      );
      return stdout.trim() || undefined;
    }
    throw unavailable();
  } catch (error) {
    const failure = commandFailure.safeParse(error);
    if (
      failure.success &&
      ((process.platform === "darwin" && failure.data.code === 44) ||
        (process.platform === "linux" &&
          failure.data.code === 1 &&
          !failure.data.stderr?.trim()))
    )
      return undefined;
    throw unavailable();
  }
}

export async function readToken(server: string): Promise<string | undefined> {
  return process.env.YOHO_TOKEN || (await readStoredToken(server));
}

export async function requireToken(server: string): Promise<string> {
  const token = await readToken(server);
  if (!token)
    throw new AppError({
      code: "AUTH_REQUIRED",
      message: "尚未登录此服务；请运行 yoho auth login 或设置 YOHO_TOKEN",
      exitCode: 4,
    });
  return token;
}

export async function saveToken(server: string, token: string): Promise<void> {
  try {
    if (process.platform === "darwin") {
      const args = [
        "add-generic-password",
        "-U",
        "-s",
        service,
        "-a",
        server,
        "-w",
        token,
        ...(await keychainArgs()),
      ];
      // security's interactive mode accepts input on stdin, keeping secrets out of argv.
      await secretInput(
        "/usr/bin/security",
        ["-i"],
        `${args.map(interactiveArgument).join(" ")}\n`,
      );
      // Interactive security can exit zero after an error; verify the intended keychain.
      if ((await readStoredToken(server)) !== token) throw unavailable();
    } else if (process.platform === "linux") {
      await secretInput(
        "secret-tool",
        ["store", "--label=Yoho CLI", "service", service, "server", server],
        token,
      );
    } else throw unavailable();
  } catch {
    throw unavailable();
  }
}

export async function deleteToken(server: string): Promise<void> {
  if (process.env.YOHO_TOKEN) return;
  try {
    if (process.platform === "darwin")
      await execute(
        "/usr/bin/security",
        [
          "delete-generic-password",
          "-s",
          service,
          "-a",
          server,
          ...(await keychainArgs()),
        ],
        { timeout: 5_000 },
      );
    else if (process.platform === "linux")
      await execute(
        "secret-tool",
        ["clear", "service", service, "server", server],
        { timeout: 5_000 },
      );
    else throw unavailable();
  } catch (error) {
    const failure = commandFailure.safeParse(error);
    if (
      failure.success &&
      process.platform === "darwin" &&
      failure.data.code === 44
    )
      return;
    throw unavailable();
  }
}

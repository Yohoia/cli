import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { AppError } from "../../core/errors.js";

export type CommandResponse = {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
};

// Run the installed entry point with complete arguments. Its existing commands
// remain the single owner of permissions, revisions, recovery and file writes.
export async function command(
  args: string[],
  signal: AbortSignal,
  diagnostics: (text: string) => void,
): Promise<CommandResponse> {
  signal.throwIfAborted();
  const entry = process.argv[1];
  if (!entry)
    throw new AppError({
      code: "IO_ERROR",
      message: "无法定位 CLI 入口",
      exitCode: 5,
    });
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve(entry), ...args, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const abort = () => {
      child.kill("SIGINT");
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdout.setEncoding("utf8").on("data", (text: string) => {
      stdout += text;
    });
    child.stderr.setEncoding("utf8").on("data", (text: string) => {
      stderr = (stderr + text).slice(-12000);
      diagnostics(stderr);
    });
    const cleanup = () => signal.removeEventListener("abort", abort);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", () => {
      cleanup();
      try {
        const result = JSON.parse(stdout) as CommandResponse;
        if (typeof result.ok !== "boolean")
          throw new Error("Invalid command response");
        done(result);
      } catch {
        reject(
          new AppError({
            code: "IO_ERROR",
            message:
              stderr.trim() ||
              "操作中断，未收到完整结果；远程写入请按原请求编号查询",
            exitCode: signal.aborted ? 130 : 5,
          }),
        );
      }
    });
  });
}

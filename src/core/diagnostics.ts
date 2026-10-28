import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { AppError } from "./errors.js";

const execute = promisify(execFile);

export type DiagnosticCheck = {
  id: string;
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
};
export type DoctorReport = { healthy: boolean; checks: DiagnosticCheck[] };

export class DoctorError extends AppError {
  constructor(readonly report: DoctorReport) {
    super({
      code: "ENVIRONMENT_CHECK_FAILED",
      message: "环境检查未通过，请按诊断结果修复后重试",
      exitCode: 2,
      data: report,
    });
  }
}

async function tool(
  name: string,
  args: string[],
  signal: AbortSignal,
): Promise<DiagnosticCheck> {
  try {
    const { stdout, stderr } = await execute(name, args, {
      signal,
      timeout: 3000,
      maxBuffer: 16_384,
    });
    return {
      id: name,
      name: name === "git" ? "Git" : "OpenSSH",
      status: "pass",
      detail: (stdout.trim() || stderr.trim()).split(/\r?\n/u)[0] || "可用",
    };
  } catch {
    signal.throwIfAborted();
    return {
      id: name,
      name: name === "git" ? "Git" : "OpenSSH",
      status: "fail",
      detail: `无法运行 ${name}；请安装并加入 PATH（Skill 命令需要）`,
    };
  }
}

async function sshConfiguration(): Promise<DiagnosticCheck> {
  const base = { id: "codeup-ssh", name: "Codeup SSH" };
  if (process.env.GIT_SSH_COMMAND)
    return {
      ...base,
      status: "warn",
      detail: "已配置 GIT_SSH_COMMAND；未执行自定义命令，仓库权限未验证",
    };
  const explicit = process.env.YOHO_SKILL_SSH_KEY;
  const key = explicit
    ? resolve(explicit)
    : join(homedir(), ".ssh", "github_codeup_sync_ed25519");
  try {
    await access(key, constants.R_OK);
    if (!(await stat(key)).isFile()) throw new Error("Not a file");
    return {
      ...base,
      status: "pass",
      detail: "发现可读私钥；未读取密钥内容，仓库权限需用 yoho skill list 验证",
    };
  } catch {
    return explicit
      ? {
          ...base,
          status: "fail",
          detail: "YOHO_SKILL_SSH_KEY 未指向可读文件；请修正路径或文件权限",
        }
      : {
          ...base,
          status: "warn",
          detail:
            "将使用 SSH 配置或 agent；请用 yoho skill list 验证 Codeup 访问权限",
        };
  }
}

export async function inspectEnvironment(
  signal: AbortSignal,
): Promise<DiagnosticCheck[]> {
  signal.throwIfAborted();
  const checks = await Promise.all([
    tool("git", ["--version"], signal),
    tool("ssh", ["-V"], signal),
    sshConfiguration(),
  ]);
  signal.throwIfAborted();
  return [
    {
      id: "node",
      name: "Node.js",
      status:
        Number(process.versions.node.split(".")[0]) >= 24 ? "pass" : "fail",
      detail: `${process.version}；需要 Node.js 24+`,
    },
    ...checks,
  ];
}

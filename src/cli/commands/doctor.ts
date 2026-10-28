import type { Command } from "commander";
import {
  DoctorError,
  inspectEnvironment,
  type DiagnosticCheck,
} from "../../core/diagnostics.js";
import { resolveServer } from "../../remote/config.js";
import { optionsSchema, type CommandContext } from "./context.js";

async function serverCheck(explicit?: string): Promise<DiagnosticCheck> {
  try {
    const server = await resolveServer(explicit);
    return {
      id: "pagehush-server",
      name: "PageHush",
      status: "pass",
      detail: `${server}；地址配置有效，未连接服务或检查设备授权`,
    };
  } catch {
    return {
      id: "pagehush-server",
      name: "PageHush",
      status: "fail",
      detail:
        "服务配置不可读或地址无效；请用 yoho config server <HTTPS origin> 设置",
    };
  }
}

export function registerDoctor(
  program: Command,
  { signal, publish }: CommandContext,
) {
  program
    .command("doctor")
    .description("检查本机环境与服务配置，不发起远程请求")
    .action(async (_options: unknown, command: Command) => {
      const options = optionsSchema.parse(command.optsWithGlobals());
      const [environment, server] = await Promise.all([
        inspectEnvironment(signal),
        serverCheck(options.server),
      ]);
      signal.throwIfAborted();
      const checks = [...environment, server];
      const data = {
        healthy: checks.every((check) => check.status !== "fail"),
        checks,
      };
      if (!data.healthy) throw new DoctorError(data);
      publish({ kind: "doctor", data });
    });
}

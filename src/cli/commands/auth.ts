import { z } from "zod";
import type { Command } from "commander";
import { login, authStatus, logout } from "../../remote/auth.js";
import { resolveServer } from "../../remote/config.js";
import { RemoteClient } from "../../remote/http.js";
import { optionsSchema, type CommandContext } from "./context.js";
export function registerAuth(
  program: Command,
  { signal, publish, client }: CommandContext,
) {
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
      publish({
        kind: "auth",
        data: await login(new RemoteClient(server, signal), {
          openBrowser: options.browser,
        }),
      });
    });
  for (const [name, handler] of [
    ["status", authStatus],
    ["logout", logout],
  ] satisfies [string, typeof authStatus | typeof logout][]) {
    auth.command(name).action(async (_options: unknown, command: Command) => {
      publish({ kind: "auth", data: await handler(await client(command)) });
    });
  }
}

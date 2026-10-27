import type { Command } from "commander";
import { saveServer } from "../../remote/config.js";
import type { CommandContext } from "./context.js";
export function registerConfig(program: Command, { publish }: CommandContext) {
  program
    .command("config")
    .description("设置单一默认服务")
    .command("server")
    .argument("<url>")
    .action(async (url: string) => {
      publish({ kind: "config", data: { server: await saveServer(url) } });
    });
}

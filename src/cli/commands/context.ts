import type { Command } from "commander";
import { z } from "zod";
import type { RemoteClient } from "../../remote/http.js";
import type { CommandResult } from "../result.js";
export const optionsSchema = z.object({
  server: z.string().optional(),
  json: z.boolean().default(false),
});
export type CommandContext = {
  signal: AbortSignal;
  publish: (result: CommandResult) => void;
  client: (command: Command) => Promise<RemoteClient>;
};

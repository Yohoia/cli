import { homedir } from "node:os";
import { join } from "node:path";
export function configDirectory(): string {
  return (
    process.env.YOHO_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "yoho")
  );
}

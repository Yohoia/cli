import type { CommandResult } from "./program.js";

export function renderText(result: CommandResult): string {
  switch (result.kind) {
    case "list":
      return `${result.data.items.map(item => `${item.id}\t${item.status}\t${item.publishedAt.slice(0, 10)}\t${item.title}`).join("\n")}\n`;
    case "show":
      return `${result.data.id}\n${result.data.path}\n版本：${result.data.revision}\n${JSON.stringify(result.data.metadata, null, 2)}\n\n${result.data.content}`;
    default: {
      const exhaustive: never = result;
      return exhaustive;
    }
  }
}

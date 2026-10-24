import type { Command } from "commander";
import { withSkillState, saveState } from "./state.js";
import { GitHub, refresh, sourceItem } from "./github.js";
import { repository, selectionSchema, type SkillResult } from "./model.js";
import { installation } from "./install.js";
import { updates } from "./update.js";
import { interact, installedStatus } from "./interaction.js";
import { roots } from "./files.js";
function selectionOptions(command: Command) {
  return command
    .option(
      "--target <target>",
      "claude、agents 或 codex；可重复",
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option("--scope <scope>", "project 或 user", "project")
    .option("--project-path <path>", "项目路径");
}
export function registerSkills(
  program: Command,
  signal: AbortSignal,
  publish: (data: SkillResult) => void,
) {
  const skill = program
    .command("skill")
    .description("管理 Skill 来源、安装和更新");
  selectionOptions(skill.command("list")).action(
    async (_options: unknown, command: Command) =>
      publish(
        await withSkillState(async (state) => {
          const selection = selectionSchema.parse(command.opts());
          const items = await installedStatus(
            await refresh(state, new GitHub(signal)),
            selection,
            state,
          );
          return {
            operation: "list",
            items,
            total: items.filter((x) => x.name).length,
            available: items.filter((x) => x.status === "available").length,
            unknown: items.filter((x) => !x.name).length,
          };
        }),
      ),
  );
  const source = skill.command("source").description("管理 GitHub 来源");
  source.command("list").action(async () =>
    publish(
      await withSkillState(async (state) => ({
        operation: "sources",
        items: state.sources.map((x) => sourceItem(x, "registered")),
        total: state.sources.length,
      })),
    ),
  );
  for (const kind of ["add", "remove"] satisfies ("add" | "remove")[]) {
    source
      .command(kind)
      .argument("<repository>")
      .action(async (raw: string) =>
        publish(
          await withSkillState(async (state) => {
            const repo = repository(raw);
            if (kind === "add") {
              if (!state.sources.some((x) => x.repo === repo))
                state.sources.push({ repo });
            } else state.sources = state.sources.filter((x) => x.repo !== repo);
            await saveState(state);
            return {
              operation: `source-${kind}`,
              items: [
                { repo, status: kind === "add" ? "registered" : "removed" },
              ],
              total: state.sources.length,
            };
          }),
        ),
      );
  }
  source.command("refresh").action(async () =>
    publish(
      await withSkillState(async (state) => {
        const items = await refresh(state, new GitHub(signal));
        return {
          operation: "refresh",
          items,
          total: items.filter((x) => x.name).length,
        };
      }),
    ),
  );
  for (const kind of ["install", "update"] satisfies ("install" | "update")[]) {
    const command = selectionOptions(
      skill.command(kind).argument("[skills...]"),
    );
    if (kind === "update")
      command.option("--all", "更新所选范围全部已有 Skill");
    command.action(
      async (names: string[], _options: unknown, command: Command) =>
        publish(
          await withSkillState(async (state) => {
            const github = new GitHub(signal);
            const input = await interact(
              kind,
              state,
              github,
              names,
              selectionSchema.parse(command.opts()),
              command.getOptionValueSource("scope") === "cli",
            );
            process.stderr.write(
              `${kind === "update" ? "更新将以仓库内容覆盖本地修改" : "安装目标"}：\n${(await roots(input.selection)).join("\n")}\n`,
            );
            return kind === "install"
              ? installation(state, github, input.names, input.selection)
              : updates(state, github, input.names, input.selection);
          }),
        ),
    );
  }
}

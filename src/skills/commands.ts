import type { Command } from "commander";
import { z } from "zod";
import { withSkillState, saveState } from "./state.js";
import { GitHub, refresh, sourceItem } from "./github.js";
import {
  repository,
  selectionSchema,
  type SkillResult,
  type UpdateScope,
  failure,
} from "./model.js";
import { installation } from "./install.js";
import { updates } from "./update.js";
import { selectInstallation, installedStatus } from "./interaction.js";
import { selectUpdates } from "./update-selection.js";
import { roots } from "./files.js";
import { withProgress, note } from "../cli/presentation.js";
import { renderText } from "../cli/output.js";
import { AppError } from "../core/errors.js";
import { prompt, terminal } from "./prompt.js";
import { uninstall, uninstallPreview } from "./uninstall.js";
import { selectUninstall } from "./uninstall-selection.js";
const uninstallOptions = z.object({
  all: z.boolean().default(false),
  yes: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});
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
    .description("管理 Skill 来源、安装、更新和删除");
  skill
    .command("uninstall")
    .alias("remove")
    .description("卸载本地 Skill 和安装记录，保留来源登记")
    .argument("[skills...]", "Skill 名称或 owner/repo")
    .option("--all", "卸载全部受管 Skill，保留来源")
    .option("--yes", "确认删除本地文件和安装记录")
    .option("--dry-run", "预览将删除的目录与安装记录，不执行删除")
    .action(async (names: string[], _options: unknown, command: Command) =>
      publish(
        await withSkillState(async (state) => {
          const options = uninstallOptions.parse(command.opts());
          const plan = await selectUninstall(state, names, options.all, signal);
          if (options.dryRun) return uninstallPreview(plan);
          if (plan.targets.length && !options.yes) {
            if (!terminal())
              throw failure(
                "CONFIRMATION_REQUIRED",
                "删除本地文件与安装记录必须提供 --yes；可先用 --dry-run 预览",
                2,
              );
            process.stderr.write(
              renderText(
                { kind: "skills", data: uninstallPreview(plan) },
                process.stderr.columns ?? 100,
                process.stderr,
              ),
            );
            const [choice] = await prompt(
              "确认删除以上文件和安装记录？",
              [
                { id: "cancel", label: "取消（默认）" },
                { id: "delete", label: "确认删除" },
              ],
              false,
              signal,
            );
            if (choice !== "delete")
              throw new AppError({
                code: "CANCELLED",
                message: "操作已取消",
                exitCode: 130,
              });
          }
          return withProgress("正在删除 Skill…", (report) =>
            uninstall(state, plan, signal, report),
          );
        }),
      ),
    );
  selectionOptions(skill.command("list")).action(
    async (_options: unknown, command: Command) =>
      publish(
        await withSkillState(async (state) => {
          const selection = selectionSchema.parse(command.opts());
          const showLocations = selection.target.length > 0;
          const automatic =
            !showLocations &&
            command.getOptionValueSource("scope") !== "cli" &&
            !selection.projectPath;
          if (!selection.target.length && !automatic)
            selection.target = ["claude", "agents", "codex"];
          const items = await installedStatus(
            await withProgress("正在获取 Skill 列表…", () =>
              refresh(state, new GitHub(signal)),
            ),
            selection,
            state,
            automatic,
          );
          return {
            operation: "list",
            items,
            total: items.filter((x) => x.name).length,
            available: items.filter((x) => x.status === "available").length,
            unknown: items.filter((x) => !x.name).length,
            showLocations,
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
        const items = await withProgress("正在检查 Skill 来源…", () =>
          refresh(state, new GitHub(signal)),
        );
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
            const selection = selectionSchema.parse(command.opts());
            if (kind === "update") {
              const constrained =
                selection.target.length > 0 ||
                command.getOptionValueSource("scope") === "cli" ||
                !!selection.projectPath;
              if (constrained && !selection.target.length)
                selection.target = ["claude", "agents", "codex"];
              const scope: UpdateScope = constrained
                ? { kind: "selected", selection }
                : { kind: "automatic", all: selection.all };
              const input = await selectUpdates(state, github, names, scope);
              if (input.kind === "complete") return input.result;
              if (input.paths.length)
                process.stderr.write(
                  note(
                    `更新已有安装位置（以仓库内容覆盖本地修改）：\n${input.paths.join("\n")}`,
                    process.stderr.columns ?? 100,
                  ) + "\n",
                );
              return withProgress("正在更新 Skill…", (report) =>
                updates(state, github, input.names, input.scope, report),
              );
            }
            const input = await selectInstallation(
              state,
              github,
              names,
              selection,
              command.getOptionValueSource("scope") === "cli",
            );
            process.stderr.write(
              note(
                `安装目标：\n${(await roots(input.selection)).join("\n")}`,
                process.stderr.columns ?? 100,
              ) + "\n",
            );
            return withProgress("正在安装 Skill…", (report) =>
              installation(state, github, input.names, input.selection, report),
            );
          }),
        ),
    );
  }
}

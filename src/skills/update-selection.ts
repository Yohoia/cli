import { AppError } from "../core/errors.js";
import { withProgress } from "../cli/presentation.js";
import { GitHub } from "./github.js";
import { checkUpdates } from "./update.js";
import { discoverUpdates } from "./inventory.js";
import { prompt, terminal } from "./prompt.js";
import {
  failure,
  SkillOperationError,
  type SkillState,
  type SkillResult,
  type UpdateScope,
} from "./model.js";

type UpdateInput =
  | { kind: "complete"; result: SkillResult }
  | { kind: "selection"; names: string[]; scope: UpdateScope; paths: string[] };
const version = (value: string | undefined) =>
  value ? (value.startsWith("v") ? value : `v${value}`) : "未标注";

export async function selectUpdates(
  state: SkillState,
  github: GitHub,
  names: string[],
  scope: UpdateScope,
): Promise<UpdateInput> {
  const all = scope.kind === "automatic" ? scope.all : scope.selection.all;
  if (names.length || all) {
    const installed = await discoverUpdates(state, scope);
    return {
      kind: "selection",
      names,
      scope,
      paths: installed
        .filter(
          (item) =>
            all ||
            names.some(
              (name) =>
                item.name === name ||
                item.path === name ||
                item.record?.repo === name,
            ),
        )
        .map((item) => item.path),
    };
  }
  if (!terminal())
    throw failure("INVALID_ARGUMENT", "请指定要更新的 Skill 或 --all", 2);
  const checked = await withProgress("正在检查可用更新…", () =>
    checkUpdates(state, github, scope),
  );
  if (!checked.ready.length) {
    const result: SkillResult = {
      operation: "update",
      items: checked.blocked.length ? checked.blocked : checked.current,
      total: checked.blocked.length || checked.current.length,
    };
    if (checked.failureError)
      throw new SkillOperationError(
        new AppError({
          code: checked.failureError.code,
          message: "更新检查失败，未将检查失败项视为最新版",
          exitCode: checked.failureError.exitCode,
        }),
        result,
      );
    if (process.argv.includes("--json"))
      process.stderr.write(
        checked.blocked.length
          ? "部分 Skill 无法更新：\n" +
              checked.blocked
                .map((item) => `${item.name}：${item.message}`)
                .join("\n") +
              "\n"
          : checked.current.length
            ? "无可用更新，Skill 均为最新版。\n"
            : "没有已安装的受管 Skill。\n",
      );
    return { kind: "complete", result };
  }
  if (checked.blocked.length)
    process.stderr.write(
      `有 ${checked.blocked.length} 个安装未通过更新检查，未列入可更新项：\n${checked.blocked.map((item) => `${item.name}：${item.message}`).join("\n")}\n`,
    );
  const groups = new Map<string, typeof checked.ready>();
  for (const entry of checked.ready) {
    const group = groups.get(entry.source.repo) ?? [];
    group.push(entry);
    groups.set(entry.source.repo, group);
  }
  names = await prompt(
    "选择更新 Skill",
    [...groups].map(([repo, entries]) => {
      const first = entries[0];
      const latest = first?.content.metadata.version;
      const old = [
        ...new Set(entries.map((entry) => version(entry.version))),
      ].join(" / ");
      return {
        id: repo,
        label: `${first?.item.name ?? repo} · ${repo}`,
        status: latest ? `${old} → ${version(latest)}` : "有更新",
        description: `更新 ${entries.length} 个已有安装位置，覆盖本地修改`,
      };
    }),
    true,
    github.signal,
  );
  return {
    kind: "selection",
    names,
    scope,
    paths: checked.ready
      .filter((entry) => names.includes(entry.source.repo))
      .map((entry) => entry.item.path),
  };
}

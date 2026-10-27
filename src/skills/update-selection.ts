import { AppError } from "../core/errors.js";
import { withProgress } from "../cli/presentation.js";
import { Codeup } from "./codeup.js";
import { checkUpdates } from "./update.js";
import { planUpdates, targetMatches, type UpdatePlan } from "./update-plan.js";
import { refresh } from "./codeup.js";
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
  | { kind: "selection"; plan: UpdatePlan; paths: string[] };
const version = (value: string | undefined) =>
  value ? (value.startsWith("v") ? value : `v${value}`) : "未标注";

export async function selectUpdates(
  state: SkillState,
  codeup: Codeup,
  names: string[],
  scope: UpdateScope,
): Promise<UpdateInput> {
  const all = scope.kind === "automatic" ? scope.all : scope.selection.all;
  if (names.length || all) {
    await withProgress("正在检查 Skill 来源…", () => refresh(state, codeup));
    const plan = await planUpdates(state, names, scope);
    return {
      kind: "selection",
      plan,
      paths: plan.targets.map((target) => target.item.path),
    };
  }
  if (!terminal())
    throw failure("INVALID_ARGUMENT", "请指定要更新的 Skill 或 --all", 2);
  const checked = await withProgress("正在检查可用更新…", () =>
    checkUpdates(state, codeup, scope),
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
        description: `更新 ${checked.plan.targets.filter((target) => targetMatches(target, repo)).length} 个已有安装位置，覆盖本地修改`,
      };
    }),
    true,
    codeup.signal,
  );
  const plan = {
    targets: checked.plan.targets.filter((target) =>
      names.some((name) => targetMatches(target, name)),
    ),
  };
  return {
    kind: "selection",
    plan,
    paths: plan.targets.map((target) => target.item.path),
  };
}

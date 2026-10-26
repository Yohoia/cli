import { failure, type SkillState } from "./model.js";
import { prompt, terminal, type Choice } from "./prompt.js";
import { planUninstall, type UninstallPlan } from "./uninstall.js";

export async function selectUninstall(
  state: SkillState,
  names: string[],
  all: boolean,
  signal: AbortSignal,
): Promise<UninstallPlan> {
  if (names.length || all) return planUninstall(state, names, all);
  if (!terminal())
    throw failure(
      "INVALID_ARGUMENT",
      "请指定要删除的 Skill 或 --all；交互终端可直接运行 uninstall 多选",
      2,
    );
  signal.throwIfAborted();
  const available = await planUninstall(state, [], true);
  const choices: Choice[] = available.sources.flatMap((source) => {
    const targets = available.targets.filter(
      (target) => target.repo === source.repo,
    );
    const installed = targets.filter((target) => target.kind === "installed");
    const blocked = targets.filter((target) => target.kind === "blocked");
    if (!installed.length && !blocked.length) return [];
    return [
      {
        id: source.repo,
        label:
          source.name === source.repo
            ? source.repo
            : `${source.name} · ${source.repo}`,
        status: installed.length ? `${installed.length} 处安装` : "不可用",
        ...(!installed.length
          ? { disabled: blocked.map((target) => target.message).join("\n") }
          : {}),
      },
    ];
  });
  if (!choices.length) return { sources: [], targets: [] };
  const selected = new Set(
    await prompt("选择删除 Skill（可多选，保留来源）", choices, true, signal),
  );
  return {
    sources: available.sources.filter((source) => selected.has(source.repo)),
    targets: available.targets.filter((target) => selected.has(target.repo)),
  };
}

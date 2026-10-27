import {
  discoverInstallations,
  sourcesForInstallation,
  type Existing,
} from "./inventory.js";
import {
  failure,
  type InstallRecord,
  type SkillState,
  type Source,
  type UpdateScope,
} from "./model.js";
export type UpdateTarget = { item: Existing; sources: Source[] };
export type UpdatePlan = { targets: UpdateTarget[] };
export function targetMatches(target: UpdateTarget, name: string): boolean {
  return (
    target.item.name === name ||
    target.item.path === name ||
    target.item.record?.repo === name ||
    (!target.item.record &&
      target.sources.length === 1 &&
      target.sources[0]?.repo === name)
  );
}
export async function planUpdates(
  state: SkillState,
  names: string[],
  scope: UpdateScope,
): Promise<UpdatePlan> {
  const all = scope.kind === "automatic" ? scope.all : scope.selection.all;
  if (all && names.length)
    throw failure("INVALID_ARGUMENT", "--all 不能与 Skill 名称同时提供", 2);
  function recordSelected(record: InstallRecord) {
    return (
      !names.length ||
      names.some(
        (name) =>
          record.name === name ||
          record.path === name ||
          record.repo === name ||
          state.sources.some(
            (source) =>
              source.repo === record.repo && source.metadata?.name === name,
          ),
      )
    );
  }
  const records = state.records.filter(recordSelected);
  const targets = (await discoverInstallations(state, scope, records)).map(
    (item) => ({ item, sources: sourcesForInstallation(state, item) }),
  );
  const chosen = names.length
    ? targets.filter((target) =>
        names.some((name) => targetMatches(target, name)),
      )
    : targets;
  if (
    names.some((name) => !chosen.some((target) => targetMatches(target, name)))
  )
    throw failure(
      "SKILL_NOT_INSTALLED",
      "指定的 Skill 未纳入 CLI 管理，或不存在于所选范围与目标中；请先登记对应来源",
    );
  return { targets: chosen };
}

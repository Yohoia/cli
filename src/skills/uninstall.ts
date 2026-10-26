import { dirname } from "node:path";
import { realpath } from "node:fs/promises";
import { AppError, normalizeError, systemErrorCode } from "../core/errors.js";
import type { ReportProgress } from "../core/progress.js";
import { discoverUpdates, sourcesForInstallation } from "./inventory.js";
import {
  backupPath,
  directoryIdentity,
  exists,
  rename,
  reserve,
  rm,
} from "./files.js";
import { saveState } from "./state.js";
import {
  failure,
  SkillOperationError,
  type SkillState,
  type SkillResult,
  type SkillItem,
} from "./model.js";

type Identity = Awaited<ReturnType<typeof directoryIdentity>>;
type Target = { repo: string; name: string; path: string } & (
  | { kind: "installed"; identity: Identity }
  | { kind: "missing" }
  | { kind: "blocked"; message: string }
);
export type UninstallPlan = {
  sources: { repo: string; name: string }[];
  targets: Target[];
};
function uninstallSources(state: SkillState) {
  const entries = new Map<string, { repo: string; name: string }>();
  for (const source of state.sources)
    entries.set(source.repo, {
      repo: source.repo,
      name: source.metadata?.name ?? source.repo,
    });
  for (const record of state.records)
    if (
      !entries.has(record.repo) ||
      entries.get(record.repo)?.name === record.repo
    )
      entries.set(record.repo, { repo: record.repo, name: record.name });
  return [...entries.values()];
}
export async function planUninstall(
  state: SkillState,
  names: string[],
  all: boolean,
): Promise<UninstallPlan> {
  if (all && names.length)
    throw failure("INVALID_ARGUMENT", "--all 不能与 Skill 名称同时提供", 2);
  const sources = uninstallSources(state);
  const selected = all
    ? sources
    : [
        ...new Set(
          names.map((name) => {
            const matches = sources.filter(
              (source) =>
                source.repo === name.toLowerCase() ||
                source.name === name ||
                state.records.some(
                  (record) =>
                    record.repo === source.repo && record.name === name,
                ),
            );
            if (matches.length !== 1 || !matches[0])
              throw failure(
                "SKILL_SOURCE_AMBIGUOUS",
                `Skill 不存在或来源不唯一：${name}；请指定 owner/repo`,
              );
            return matches[0];
          }),
        ),
      ];
  const repos = new Set(selected.map((source) => source.repo));
  const records = state.records.filter((record) => repos.has(record.repo));
  const installed = await discoverUpdates(
    { ...state, records },
    { kind: "automatic", all: false },
  );
  const targets: Target[] = [];
  for (const item of installed) {
    const matches = item.record
      ? [item.record]
      : sourcesForInstallation(state, item);
    for (const source of matches.filter((source) => repos.has(source.repo))) {
      const base = { repo: source.repo, name: item.name, path: item.path };
      if (item.problem || matches.length !== 1)
        targets.push({
          ...base,
          kind: "blocked",
          message:
            item.problem ?? "同名 Skill 对应多个来源，未删除无法确认归属的目录",
        });
      else {
        try {
          targets.push({
            ...base,
            kind: "installed",
            identity: await directoryIdentity(item.path),
          });
        } catch (error) {
          if (systemErrorCode(error) !== "ENOENT") throw error;
          targets.push({ ...base, kind: "missing" });
        }
      }
    }
  }
  for (const record of records)
    if (!targets.some((target) => target.path === record.path))
      targets.push({
        repo: record.repo,
        name: record.name,
        path: record.path,
        kind: "missing",
      });
  return { sources: selected, targets };
}
export function uninstallPreview(plan: UninstallPlan): SkillResult {
  const items: SkillItem[] = plan.targets.map((target) => ({
    repo: target.repo,
    name: target.name,
    path: target.path,
    ...(target.kind === "blocked"
      ? { status: "failed", message: target.message }
      : {
          status: "planned",
          ...(target.kind === "missing"
            ? { message: "目录已不存在，将清理安装记录" }
            : {}),
        }),
  }));
  return {
    operation: "uninstall-preview",
    sources: plan.sources.map((source) => source.repo),
    items,
    total: items.length,
  };
}
async function sameDirectory(path: string, identity: Identity) {
  const current = await directoryIdentity(path);
  return (
    current.dev === identity.dev &&
    current.ino === identity.ino &&
    current.birthtimeNs === identity.birthtimeNs
  );
}
async function deleteTarget(target: Target, signal: AbortSignal) {
  if (target.kind === "blocked")
    throw failure("SKILL_TARGET_UNSAFE", target.message, 5);
  signal.throwIfAborted();
  if (target.kind === "missing") {
    if (await exists(target.path))
      throw failure(
        "SKILL_TARGET_CHANGED",
        `预览后目标已出现，未删除：${target.path}`,
        5,
      );
    return;
  }
  if ((await realpath(dirname(target.path))) !== dirname(target.path))
    throw failure(
      "SKILL_TARGET_UNSAFE",
      `目标父目录已被重定向：${target.path}`,
      5,
    );
  const release = await reserve(target.path);
  const backup = backupPath(target.path);
  let moved = false;
  try {
    signal.throwIfAborted();
    if (!(await sameDirectory(target.path, target.identity)))
      throw failure(
        "SKILL_TARGET_CHANGED",
        `预览后目标已被替换，未删除：${target.path}`,
        5,
      );
    await rename(target.path, backup);
    moved = true;
    if (!(await sameDirectory(backup, target.identity)))
      throw failure(
        "SKILL_TARGET_CHANGED",
        `删除期间目标被替换，保留内容：${backup}`,
        5,
      );
    signal.throwIfAborted();
    await rm(backup, { recursive: true });
  } catch (error) {
    if (moved && (await exists(backup))) {
      if (await exists(target.path))
        throw failure(
          "SKILL_RECOVERY_REQUIRED",
          `目标位置已被占用，请核对保留目录：${backup}`,
          5,
        );
      try {
        await rename(backup, target.path);
      } catch {
        throw failure(
          "SKILL_RECOVERY_REQUIRED",
          `删除未完成，无法恢复原位置，请核对保留目录：${backup}`,
          5,
        );
      }
    }
    throw error;
  } finally {
    await release();
  }
}
export async function uninstall(
  state: SkillState,
  plan: UninstallPlan,
  signal: AbortSignal,
  report: ReportProgress,
): Promise<SkillResult> {
  const items: SkillItem[] = [];
  let firstFailure: AppError | undefined;
  for (const target of plan.targets) {
    if (signal.aborted) {
      firstFailure ??= normalizeError(new Error("操作已取消"), signal);
      break;
    }
    report({
      completed: items.length,
      total: plan.targets.length,
      message: `删除 ${target.name}`,
    });
    let oldRecords = [...state.records];
    let filesDeleted = false;
    try {
      if (
        target.kind === "installed" &&
        !state.records.some((record) => record.path === target.path)
      ) {
        state.records.push({
          repo: target.repo,
          name: target.name,
          path: target.path,
          commit: null,
        });
        await saveState(state);
        oldRecords = [...state.records];
      }
      await deleteTarget(target, signal);
      filesDeleted = true;
      state.records = state.records.filter(
        (record) => record.path !== target.path,
      );
      await saveState(state);
      items.push({
        repo: target.repo,
        name: target.name,
        path: target.path,
        status: "uninstalled",
        ...(target.kind === "missing"
          ? { message: "目录已不存在，已清理安装记录" }
          : {}),
      });
    } catch (error) {
      state.records = oldRecords;
      const problem = normalizeError(error, signal);
      firstFailure ??= problem;
      items.push({
        repo: target.repo,
        name: target.name,
        path: target.path,
        status: "failed",
        message: filesDeleted
          ? `本地目录已删除，但安装记录清理失败；请重试：${problem.message}`
          : problem.message,
      });
    }
    report({
      completed: items.length,
      total: plan.targets.length,
      message: `已处理 ${target.name}`,
    });
  }
  if (signal.aborted)
    firstFailure ??= normalizeError(new Error("操作已取消"), signal);
  const result: SkillResult = {
    operation: "uninstall",
    removedSources: [],
    items,
    total: items.length,
  };
  if (firstFailure) throw new SkillOperationError(firstFailure, result);
  return result;
}

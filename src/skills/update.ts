import {
  discoverUpdates,
  sourcesForInstallation,
  installedVersion,
  type Existing,
} from "./inventory.js";
import { dirname } from "node:path";
import { AppError, normalizeError } from "../core/errors.js";
import type { ReportProgress } from "../core/progress.js";
import {
  exists,
  localFiles,
  stageFiles,
  reserve,
  backupPath,
  rename,
  rm,
} from "./files.js";
import { GitHub, refresh } from "./github.js";
import { fingerprint } from "./archive.js";
import { prepare, type Prepared } from "./install.js";
import { saveState } from "./state.js";
import {
  failure,
  type SkillState,
  type UpdateScope,
  type SkillResult,
  type TargetItem,
  type Source,
  SkillOperationError,
} from "./model.js";
export type AvailableUpdate = {
  item: Existing;
  source: Source;
  content: Prepared;
  version?: TargetItem["version"];
};
export async function checkUpdates(
  state: SkillState,
  github: GitHub,
  scope: UpdateScope,
) {
  await refresh(state, github);
  const ready: AvailableUpdate[] = [];
  const current: TargetItem[] = [];
  const blocked: TargetItem[] = [];
  const prepared = new Map<string, Prepared>();
  let failureError: AppError | undefined;
  for (const item of await discoverUpdates(state, scope)) {
    const sources = sourcesForInstallation(state, item);
    const source = sources.length === 1 ? sources[0] : undefined;
    if (item.problem || !source) {
      const message =
        item.problem ??
        (item.record
          ? `来源已移除：${item.record.repo}；恢复：yoho skill source add ${item.record.repo}`
          : `同名来源不唯一：${sources.map((source) => source.repo).join("、")}`);
      if (item.kind === "recovery")
        failureError ??= failure("SKILL_RECOVERY_REQUIRED", message, 5);
      blocked.push({
        repo: item.record?.repo ?? "",
        name: item.name,
        path: item.path,
        status: item.kind === "recovery" ? "failed" : "skipped",
        message,
      });
      continue;
    }
    let latest: Prepared["metadata"] | undefined;
    try {
      latest = await github.metadata(source.repo);
      let content = prepared.get(source.repo);
      if (!content) {
        content = await prepare(source, github);
        prepared.set(source.repo, content);
      }
      if (content.metadata.name !== item.name)
        throw failure(
          "SKILL_IDENTITY_CHANGED",
          `来源中的 Skill 名称已从 ${item.name} 改为 ${content.metadata.name}`,
        );
      const unchanged =
        item.record?.commit === content.metadata.commit &&
        fingerprint(await localFiles(item.path)) === fingerprint(content.files);
      if (unchanged)
        current.push({
          repo: source.repo,
          ...content.metadata,
          path: item.path,
          status: "unchanged",
        });
      else
        ready.push({
          item,
          source,
          content,
          version: await installedVersion(state, item.path),
        });
    } catch (error) {
      const problem = normalizeError(error, github.signal);
      failureError ??= problem;
      blocked.push({
        repo: source.repo,
        name: item.name,
        path: item.path,
        status: "failed",
        ...(latest ? { commit: latest.commit, version: latest.version } : {}),
        message: `来源暂不可用或更新检查失败：${problem.message}`,
      });
      if (github.signal.aborted) break;
    }
  }
  return { ready, current, blocked, failureError };
}
export async function updates(
  state: SkillState,
  github: GitHub,
  names: string[],
  scope: UpdateScope,
  report: ReportProgress = () => {},
): Promise<SkillResult> {
  const all = scope.kind === "automatic" ? scope.all : scope.selection.all;
  if (
    (scope.kind === "selected" && !scope.selection.target.length) ||
    (!all && !names.length)
  )
    throw failure(
      "INVALID_ARGUMENT",
      "请指定要更新的 Skill 或显式 --all，并提供 --target",
      2,
    );
  if (all && names.length)
    throw failure("INVALID_ARGUMENT", "--all 不能与 Skill 名称同时提供", 2);
  await refresh(state, github);
  const existing = await discoverUpdates(state, scope);
  function matches(item: Existing, name: string) {
    if (item.name === name || item.path === name || item.record?.repo === name)
      return true;
    if (item.record) return false;
    const sources = sourcesForInstallation(state, item);
    return sources.length === 1 && sources[0]?.repo === name;
  }
  const chosen = existing.filter(
    (x) => all || names.some((name) => matches(x, name)),
  );
  if (!all && names.some((name) => !chosen.some((item) => matches(item, name))))
    throw failure(
      "SKILL_NOT_INSTALLED",
      "指定的 Skill 未纳入 CLI 管理，或不存在于所选范围与目标中；请先登记对应来源",
    );
  const items: TargetItem[] = [];
  let firstFailure: AppError | undefined;
  const prepared = new Map<string, Prepared>();
  const unavailable = new Map<string, AppError>();
  for (const item of chosen) {
    if (github.signal.aborted) {
      firstFailure ??= normalizeError(new Error("操作已取消"), github.signal);
      break;
    }
    report({
      completed: items.length,
      total: chosen.length,
      message: `更新 ${item.name}`,
    });
    try {
      let record = item.record;
      if (item.problem) {
        if (item.kind === "recovery")
          firstFailure ??= failure("SKILL_RECOVERY_REQUIRED", item.problem, 5);
        items.push({
          repo: record?.repo ?? "",
          name: item.name,
          path: item.path,
          status: item.kind === "recovery" ? "failed" : "skipped",
          message: item.problem,
        });
        continue;
      }
      if (!record) {
        const candidates = sourcesForInstallation(state, item);
        const match = candidates[0];
        if (candidates.length !== 1 || !match) {
          const hint =
            candidates.length > 1
              ? `同名来源不唯一：${candidates.map((x) => x.repo).join("、")}。请确认来源后重试。`
              : `未找到匹配来源（Skill：${item.name}）。请先运行 yoho skill source add <owner/repo>，再重试。`;
          items.push({
            repo: "",
            name: item.name,
            path: item.path,
            status: "skipped",
            message: hint,
          });
          continue;
        }
        record = {
          repo: match.repo,
          name: item.name,
          path: item.path,
          commit: null,
        };
      }
      const source = state.sources.find((x) => x.repo === record.repo);
      if (!source) {
        items.push({
          repo: record.repo,
          name: record.name,
          path: record.path,
          status: "skipped",
          ...(record.commit ? { commit: record.commit } : {}),
          message: `来源已移除，暂停更新。恢复：yoho skill source add ${record.repo}`,
        });
        continue;
      }
      let stage: string | undefined;
      let release: (() => Promise<void>) | undefined;
      let backup: string | undefined;
      let replaced = false;
      let latest: Prepared["metadata"] | undefined;
      const oldRecords = [...state.records];
      try {
        if (!item.record) {
          state.records.push(record);
          await saveState(state);
          oldRecords.push(record);
        }
        latest = await github.metadata(source.repo);
        const previousError = unavailable.get(source.repo);
        if (previousError) throw previousError;
        let content = prepared.get(source.repo);
        if (!content) {
          try {
            content = await prepare(source, github);
            prepared.set(source.repo, content);
          } catch (error) {
            const problem = normalizeError(error, github.signal);
            unavailable.set(source.repo, problem);
            throw problem;
          }
        }
        if (content.metadata.name !== record.name)
          throw failure(
            "SKILL_IDENTITY_CHANGED",
            `来源名称变化，未重命名安装：${item.path}`,
          );
        latest = content.metadata;
        release = await reserve(item.path);
        const files = await localFiles(item.path);
        const unchanged =
          fingerprint(files) === fingerprint(content.files) &&
          record.commit === content.metadata.commit;
        if (!unchanged) {
          stage = await stageFiles(
            dirname(item.path),
            content.files,
            github.signal,
          );
          github.signal.throwIfAborted();
          backup = backupPath(item.path);
          await rename(item.path, backup);
          try {
            await rename(stage, item.path);
            stage = undefined;
            replaced = true;
          } catch (error) {
            await rename(backup, item.path);
            backup = undefined;
            throw error;
          }
        }
        github.signal.throwIfAborted();
        state.records = state.records.filter((x) => x.path !== item.path);
        state.records.push({
          ...record,
          commit: content.metadata.commit,
          version: content.metadata.version,
        });
        await saveState(state);
        let message: string | undefined;
        if (backup) {
          try {
            await rm(backup, { recursive: true });
          } catch {
            message = `更新成功，但备份清理失败：${backup}`;
            firstFailure ??= failure("SKILL_CLEANUP_FAILED", message, 5);
          }
          backup = undefined;
        }
        items.push({
          repo: record.repo,
          ...content.metadata,
          path: item.path,
          status: unchanged ? "unchanged" : "updated",
          ...(message ? { message } : {}),
        });
      } catch (error) {
        let problem = normalizeError(error, github.signal);
        state.records = oldRecords;
        try {
          if (backup) {
            if (replaced && (await exists(item.path)))
              await rm(item.path, { recursive: true });
            await rename(backup, item.path);
            backup = undefined;
          }
          await saveState(state);
        } catch {
          problem = failure(
            "SKILL_RESTORE_FAILED",
            `恢复失败，请检查目标 ${item.path} 与备份 ${backup ?? "安装记录"}`,
            5,
          );
        }
        firstFailure ??= problem;
        items.push({
          repo: record.repo,
          name: record.name,
          path: item.path,
          status: "failed",
          message: problem.message,
          ...(latest
            ? {
                commit: latest.commit,
                ...(latest.version ? { version: latest.version } : {}),
              }
            : {}),
        });
        if (github.signal.aborted) break;
      } finally {
        if (stage)
          await rm(stage, { recursive: true, force: true }).catch(() => {});
        if (release) await release();
      }
    } finally {
      report({
        completed: items.length,
        total: chosen.length,
        message: `已处理 ${item.name}`,
      });
    }
  }
  const result: SkillResult = {
    operation: "update",
    items,
    total: items.length,
  };
  if (firstFailure) {
    throw new SkillOperationError(
      new AppError({
        code: firstFailure.code,
        message: "部分更新失败，请查看逐目标结果",
        exitCode: firstFailure.exitCode,
      }),
      result,
    );
  }
  return result;
}

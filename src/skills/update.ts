import { discover, type Existing } from "./inventory.js";
import { dirname } from "node:path";
import { AppError, normalizeError } from "../core/errors.js";
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
  type Selection,
  type SkillResult,
  type TargetItem,
} from "./model.js";
export async function updates(
  state: SkillState,
  github: GitHub,
  names: string[],
  selection: Selection,
): Promise<SkillResult> {
  if (!selection.target.length || (!selection.all && !names.length))
    throw failure(
      "INVALID_ARGUMENT",
      "请指定要更新的 Skill 或显式 --all，并提供 --target",
      2,
    );
  if (selection.all && names.length)
    throw failure("INVALID_ARGUMENT", "--all 不能与 Skill 名称同时提供", 2);
  await refresh(state, github);
  const existing = await discover(state, selection);
  function matches(item: Existing, name: string) {
    if (item.name === name || item.path === name || item.record?.repo === name)
      return true;
    if (item.record) return false;
    const sources = state.sources.filter((x) => x.metadata?.name === item.name);
    return sources.length === 1 && sources[0]?.repo === name;
  }
  const chosen = existing.filter(
    (x) => selection.all || names.some((name) => matches(x, name)),
  );
  if (
    !selection.all &&
    names.some((name) => !chosen.some((item) => matches(item, name)))
  )
    throw failure(
      "SKILL_NOT_INSTALLED",
      "指定的 Skill 不存在于所选范围与目标中",
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
      const candidates = state.sources.filter(
        (x) => x.metadata?.name === item.name,
      );
      const match = candidates[0];
      if (candidates.length !== 1 || !match) {
        items.push({
          repo: "",
          name: item.name,
          path: item.path,
          status: "skipped",
          message: "来源未找到或不唯一，未建立关联",
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
        message: "来源已移除，暂停更新",
      });
      continue;
    }
    let stage: string | undefined;
    let release: (() => Promise<void>) | undefined;
    let backup: string | undefined;
    let replaced = false;
    const oldRecords = [...state.records];
    try {
      if (!item.record) {
        state.records.push(record);
        await saveState(state);
        oldRecords.push(record);
      }
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
      state.records.push({ ...record, commit: content.metadata.commit });
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
      });
      if (github.signal.aborted) break;
    } finally {
      if (stage)
        await rm(stage, { recursive: true, force: true }).catch(() => {});
      if (release) await release();
    }
  }
  const result: SkillResult = {
    operation: "update",
    items,
    total: items.length,
  };
  if (firstFailure) {
    if (!process.argv.includes("--json"))
      process.stderr.write(
        items
          .map((x) => `${x.name}\t${x.status}\t${x.path}\t${x.message ?? ""}`)
          .join("\n") + "\n",
      );
    throw new AppError({
      code: firstFailure.code,
      message: "部分更新失败，请查看逐目标结果",
      exitCode: firstFailure.exitCode,
      data: result,
    });
  }
  return result;
}

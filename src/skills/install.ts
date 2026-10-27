import { parseSkill } from "./manifest.js";
import { join, dirname } from "node:path";
import type { ReportProgress } from "../core/progress.js";
import { discover } from "./inventory.js";
import { Codeup, refresh } from "./codeup.js";
import { saveState } from "./state.js";
import {
  roots,
  exists,
  stageFiles,
  reserve,
  rename,
  guardDirectory,
  ensureDirectory,
  assertGuard,
  removeGuardedDirectory,
  type DirectoryGuard,
} from "./files.js";
import { unpack, type SkillFiles } from "./archive.js";
import {
  failure,
  type SkillState,
  type Selection,
  type Source,
  type Metadata,
  type TargetItem,
  type SkillResult,
} from "./model.js";
export type Prepared = { repo: string; metadata: Metadata; files: SkillFiles };
export function chooseSource(state: SkillState, name: string): Source {
  const matches = state.sources.filter(
    (x) => x.repo === name || x.metadata?.name === name,
  );
  if (matches.length !== 1 || !matches[0])
    throw failure(
      "SKILL_SOURCE_AMBIGUOUS",
      `Skill 来源未找到或不唯一：${name}；请指定 Codeup 命名空间/仓库路径`,
    );
  if (matches[0].legacyGithub)
    throw failure(
      "SOURCE_MIGRATION_REQUIRED",
      "旧 GitHub 来源需要先登记对应 Codeup 来源",
      2,
    );
  return matches[0];
}
export async function prepare(
  source: Source,
  codeup: Codeup,
): Promise<Prepared> {
  if (source.legacyGithub)
    throw failure(
      "SOURCE_MIGRATION_REQUIRED",
      "旧 GitHub 来源需要先登记对应 Codeup 来源",
      2,
    );
  const metadata = await codeup.metadata(source.repo);
  if (source.metadata && source.metadata.name !== metadata.name)
    throw failure(
      "SKILL_IDENTITY_CHANGED",
      `来源 Skill 名称已变化：${source.repo}`,
    );
  const files = unpack(await codeup.archive(source.repo, metadata.commit));
  const entry = files.get("SKILL.md");
  const identity = entry ? parseSkill(entry.bytes) : undefined;
  if (
    !identity ||
    identity.name !== metadata.name ||
    identity.version !== metadata.version
  )
    throw failure("SKILL_IDENTITY_CHANGED", "归档 Skill 身份与元数据不一致");
  source.metadata = metadata;
  return { repo: source.repo, metadata, files };
}
export async function installation(
  state: SkillState,
  codeup: Codeup,
  names: string[],
  selection: Selection,
  report: ReportProgress = () => {},
): Promise<SkillResult> {
  if (!selection.target.length || !names.length)
    throw failure(
      "INVALID_ARGUMENT",
      "请指定 Skill 与 --target；交互模式可直接运行 install",
      2,
    );
  const destinations = await roots(selection);
  const anchors = new Map(
    await Promise.all(
      destinations.map(
        async (root) => [root, await guardDirectory(root)] as const,
      ),
    ),
  );
  await refresh(state, codeup);
  const selected = [...new Set(names.map((name) => chooseSource(state, name)))];
  const existing = await discover(state, selection);
  const items: TargetItem[] = [];
  const planned: { source: Source; path: string }[] = [];
  const paths = new Set<string>();
  for (const source of selected) {
    if (!source.metadata) source.metadata = await codeup.metadata(source.repo);
    for (const root of destinations) {
      const matching = existing.find(
        (x) =>
          dirname(x.path) === root &&
          x.name === source.metadata?.name &&
          !x.problem,
      );
      const path = matching?.path ?? join(root, source.metadata.name);
      if (paths.has(path))
        throw failure("SKILL_NAME_CONFLICT", `不同来源使用相同目标：${path}`);
      paths.add(path);
      if (await exists(path))
        items.push({
          repo: source.repo,
          name: source.metadata.name,
          status: "skipped",
          path,
          message: "已安装或同名目录已存在",
        });
      else planned.push({ source, path });
    }
  }
  const prepared = new Map<string, Prepared>();
  report({ completed: 0, total: planned.length, message: "准备下载 Skill" });
  for (const { source } of planned) {
    codeup.signal.throwIfAborted();
    if (!prepared.has(source.repo)) {
      report({
        completed: 0,
        total: planned.length,
        message: `下载 ${source.metadata?.name ?? source.repo}`,
      });
      prepared.set(source.repo, await prepare(source, codeup));
    }
  }
  const oldRecords = [...state.records];
  const created: DirectoryGuard[] = [];
  const parents = new Map<string, DirectoryGuard>();
  const locks: (() => Promise<void>)[] = [];
  try {
    for (const { source, path } of planned) {
      report({
        completed: created.length,
        total: planned.length,
        message: `写入 ${source.metadata?.name ?? source.repo}`,
      });
      const contents = prepared.get(source.repo);
      if (!contents)
        throw failure("SKILL_UNAVAILABLE", "缺少准备好的 Skill", 5);
      const root = destinations.find(
        (x) => path === join(x, contents.metadata.name),
      );
      if (!root) throw failure("SKILL_TARGET_UNSAFE", "目标路径无效");
      const anchor = anchors.get(root);
      if (!anchor)
        throw failure("SKILL_TARGET_UNSAFE", "缺少目标目录的预检身份", 5);
      let parent = parents.get(root);
      if (!parent) {
        parent = await ensureDirectory(root, anchor, codeup.signal);
        parents.set(root, parent);
      }
      await assertGuard(parent);
      const stage = await stageFiles(parent, contents.files, codeup.signal);
      let published = false;
      try {
        await assertGuard(parent);
        locks.push(await reserve(path));
        await assertGuard(parent);
        if (await exists(path))
          throw failure("SKILL_TARGET_CHANGED", `预检后目标已存在：${path}`);
        codeup.signal.throwIfAborted();
        await assertGuard(stage);
        await rename(stage.path, path);
        published = true;
        const installed: DirectoryGuard = {
          path,
          identity: stage.identity,
          parent,
        };
        created.push(installed);
        await assertGuard(installed);
        state.records = state.records.filter((x) => x.path !== path);
        state.records.push({
          repo: source.repo,
          name: contents.metadata.name,
          path,
          commit: contents.metadata.commit,
          ...(contents.metadata.version
            ? { version: contents.metadata.version }
            : {}),
        });
        items.push({
          repo: source.repo,
          ...contents.metadata,
          path,
          status: "installed",
        });
        report({
          completed: created.length,
          total: planned.length,
          message: `已写入 ${contents.metadata.name}`,
        });
      } finally {
        if (!published) await removeGuardedDirectory(stage);
      }
    }
    for (const installed of created) await assertGuard(installed);
    await saveState(state);
    for (const installed of created) await assertGuard(installed);
  } catch (error) {
    const remnants: string[] = [];
    for (const installed of created.reverse())
      try {
        await removeGuardedDirectory(installed);
      } catch (cleanupError) {
        remnants.push(
          cleanupError instanceof Error ? cleanupError.message : installed.path,
        );
      }
    state.records = oldRecords;
    try {
      await saveState(state);
    } catch {
      remnants.push("安装记录");
    }
    if (remnants.length)
      throw failure(
        "SKILL_ROLLBACK_FAILED",
        `安装失败，无法清理：${remnants.join("、")}`,
        5,
      );
    throw error;
  } finally {
    for (const release of locks) await release();
  }
  return { operation: "install", items, total: items.length };
}

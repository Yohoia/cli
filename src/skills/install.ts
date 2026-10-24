import { join, dirname } from "node:path";
import { discover } from "./inventory.js";
import { GitHub, parseSkill, refresh } from "./github.js";
import { saveState } from "./state.js";
import {
  roots,
  exists,
  stageFiles,
  reserve,
  rename,
  rm,
  directoryIdentity,
  removeCreatedDirectory,
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
    (x) => x.repo === name.toLowerCase() || x.metadata?.name === name,
  );
  if (matches.length !== 1 || !matches[0])
    throw failure(
      "SKILL_SOURCE_AMBIGUOUS",
      `Skill 来源未找到或不唯一：${name}；请指定 owner/repo`,
    );
  return matches[0];
}
export async function prepare(
  source: Source,
  github: GitHub,
): Promise<Prepared> {
  const metadata = await github.metadata(source.repo);
  if (source.metadata && source.metadata.name !== metadata.name)
    throw failure(
      "SKILL_IDENTITY_CHANGED",
      `来源 Skill 名称已变化：${source.repo}`,
    );
  const files = unpack(await github.archive(source.repo, metadata.commit));
  const entry = files.get("SKILL.md");
  if (!entry || parseSkill(entry.bytes).name !== metadata.name)
    throw failure("SKILL_IDENTITY_CHANGED", "归档 Skill 身份与元数据不一致");
  source.metadata = metadata;
  return { repo: source.repo, metadata, files };
}
export async function installation(
  state: SkillState,
  github: GitHub,
  names: string[],
  selection: Selection,
): Promise<SkillResult> {
  if (!selection.target.length || !names.length)
    throw failure(
      "INVALID_ARGUMENT",
      "请指定 Skill 与 --target；交互模式可直接运行 install",
      2,
    );
  await refresh(state, github);
  const selected = [...new Set(names.map((name) => chooseSource(state, name)))];
  const destinations = await roots(selection);
  const existing = await discover(state, selection);
  const items: TargetItem[] = [];
  const planned: { source: Source; path: string }[] = [];
  const paths = new Set<string>();
  for (const source of selected) {
    if (!source.metadata) source.metadata = await github.metadata(source.repo);
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
  for (const { source } of planned) {
    github.signal.throwIfAborted();
    if (!prepared.has(source.repo))
      prepared.set(source.repo, await prepare(source, github));
  }
  const oldRecords = [...state.records];
  const created: {
    path: string;
    identity: Awaited<ReturnType<typeof directoryIdentity>>;
  }[] = [];
  const locks: (() => Promise<void>)[] = [];
  try {
    for (const { source, path } of planned) {
      const contents = prepared.get(source.repo);
      if (!contents)
        throw failure("SKILL_UNAVAILABLE", "缺少准备好的 Skill", 5);
      const root = destinations.find(
        (x) => path === join(x, contents.metadata.name),
      );
      if (!root) throw failure("SKILL_TARGET_UNSAFE", "目标路径无效");
      const stage = await stageFiles(root, contents.files, github.signal);
      try {
        locks.push(await reserve(path));
        if (await exists(path))
          throw failure("SKILL_TARGET_CHANGED", `预检后目标已存在：${path}`);
        github.signal.throwIfAborted();
        const identity = await directoryIdentity(stage);
        await rename(stage, path);
        created.push({ path, identity });
        state.records = state.records.filter((x) => x.path !== path);
        state.records.push({
          repo: source.repo,
          name: contents.metadata.name,
          path,
          commit: contents.metadata.commit,
        });
        items.push({
          repo: source.repo,
          ...contents.metadata,
          path,
          status: "installed",
        });
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    }
    await saveState(state);
  } catch (error) {
    const remnants: string[] = [];
    for (const { path, identity } of created.reverse())
      try {
        await removeCreatedDirectory(path, identity);
      } catch (cleanupError) {
        remnants.push(
          cleanupError instanceof Error ? cleanupError.message : path,
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

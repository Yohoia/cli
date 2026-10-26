import { readdir, readFile, lstat, realpath } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { systemErrorCode } from "../core/errors.js";
import { roots, isBackupFor } from "./files.js";
import { parseSkill } from "./github.js";
import {
  failure,
  type SkillState,
  type InstallRecord,
  type Selection,
  type Source,
  type UpdateScope,
  targetSchema,
} from "./model.js";
export type Existing = {
  path: string;
  name: string;
  record: InstallRecord | undefined;
} & (
  | { kind: "installed"; problem: string | undefined }
  | { kind: "recovery"; problem: string }
);
export function sourcesForInstallation(
  state: SkillState,
  item: Existing,
): Source[] {
  return state.sources.filter((source) =>
    item.record
      ? source.repo === item.record.repo
      : source.metadata?.name === item.name,
  );
}
export async function installedVersion(
  state: SkillState,
  path: string,
): Promise<string | undefined> {
  const record = state.records.find((record) => record.path === path);
  if (record?.version) return record.version;
  try {
    const entry = join(path, "SKILL.md");
    const info = await lstat(entry);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    return parseSkill(await readFile(entry)).version;
  } catch {
    return undefined;
  }
}
export async function discoverManaged(
  state: SkillState,
  selection: Selection,
): Promise<Existing[]> {
  return (await discover(state, selection)).filter(
    (item) =>
      item.record !== undefined ||
      sourcesForInstallation(state, item).length > 0,
  );
}
export async function discover(
  state: SkillState,
  selection: Selection,
): Promise<Existing[]> {
  return discoverAtRoots(state, await roots(selection));
}
export async function discoverUpdates(
  state: SkillState,
  scope: UpdateScope,
): Promise<Existing[]> {
  if (scope.kind === "selected") return discoverManaged(state, scope.selection);
  const target = [...targetSchema.options];
  const normal = [
    ...(await roots({ scope: "project", target, all: false })),
    ...(await roots({ scope: "user", target, all: false })),
  ];
  for (const record of state.records) {
    if (
      resolve(record.path) !== record.path ||
      dirname(record.path) === record.path
    )
      throw failure(
        "SKILL_CONFIG_INVALID",
        `安装记录位置无效：${record.path}`,
        2,
      );
    try {
      if ((await realpath(dirname(record.path))) !== dirname(record.path))
        throw failure(
          "SKILL_TARGET_UNSAFE",
          `安装记录的父目录已被重定向，请核对：${record.path}`,
          5,
        );
    } catch (error) {
      if (systemErrorCode(error) !== "ENOENT") throw error;
    }
  }
  const recorded = new Set(state.records.map((record) => record.path));
  const directories = [
    ...new Set([
      ...normal,
      ...state.records.map((record) => dirname(record.path)),
    ]),
  ];
  return (await discoverAtRoots(state, directories)).filter(
    (item) =>
      (normal.includes(dirname(item.path)) || recorded.has(item.path)) &&
      (item.record !== undefined ||
        sourcesForInstallation(state, item).length > 0),
  );
}
async function discoverAtRoots(
  state: SkillState,
  directories: string[],
): Promise<Existing[]> {
  const found: Existing[] = [];
  for (const root of directories) {
    let names: string[];
    try {
      names = await readdir(root);
    } catch (error) {
      if (systemErrorCode(error) === "ENOENT") continue;
      throw error;
    }
    for (const folder of names.sort()) {
      if (folder.startsWith(".yoho-")) continue;
      const path = join(root, folder);
      const record = state.records.find((x) => x.path === path);
      let name = record?.name ?? folder;
      let problem: string | undefined;
      try {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw failure("SKILL_TARGET_UNSAFE", `目标不是普通目录：${path}`);
        if (!record) {
          const entry = join(path, "SKILL.md");
          const info = await lstat(entry);
          if (!info.isFile() || info.isSymbolicLink())
            throw failure("SKILL_TARGET_UNSAFE", "Skill 入口不是普通文件");
          name = parseSkill(await readFile(entry)).name;
        }
      } catch (error) {
        problem = error instanceof Error ? error.message : "无法解析 Skill";
      }
      found.push({ kind: "installed", path, name, record, problem });
    }
    for (const record of state.records.filter(
      (x) =>
        dirname(x.path) === root && !found.some((item) => item.path === x.path),
    )) {
      const backups = names.filter((name) => isBackupFor(name, record.path));
      if (backups.length)
        found.push({
          kind: "recovery",
          path: record.path,
          name: record.name,
          record,
          problem: `中断备份需要核对后恢复：${backups.map((x) => join(root, x)).join("、")}`,
        });
    }
  }
  return found;
}

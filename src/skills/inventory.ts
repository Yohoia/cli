import { readdir, readFile, lstat, realpath } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { systemErrorCode } from "../core/errors.js";
import {
  roots,
  rootPaths,
  canonicalPath,
  isBackupFor,
  directoryIdentity,
} from "./files.js";
import { parseSkill } from "./manifest.js";
import {
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
  | {
      kind: "installed";
      present: true;
      identity: Awaited<ReturnType<typeof directoryIdentity>>;
      problem: undefined;
    }
  | { kind: "recovery" | "unsafe"; present: boolean; problem: string }
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
  path: string,
): Promise<string | undefined> {
  try {
    const entry = join(path, "SKILL.md");
    const info = await lstat(entry);
    if (!info.isFile() || info.isSymbolicLink()) return undefined;
    return parseSkill(await readFile(entry)).version;
  } catch {
    return undefined;
  }
}
export async function discover(
  state: SkillState,
  selection: Selection,
): Promise<Existing[]> {
  return discoverAtRoots(state, await roots(selection));
}
export async function discoverInstallations(
  state: SkillState,
  scope: UpdateScope,
  records: InstallRecord[] = state.records,
): Promise<Existing[]> {
  const target = [...targetSchema.options];
  const selections: Selection[] =
    scope.kind === "selected"
      ? [scope.selection]
      : [
          { scope: "project", target, all: false },
          { scope: "user", target, all: false },
        ];
  const requested = new Set(
    (await Promise.all(selections.map(rootPaths))).flat(),
  );
  const normal = new Set<string>();
  const rootErrors = new Map<string, unknown>();
  for (const root of requested) {
    try {
      normal.add(await canonicalPath(root));
    } catch (error) {
      rootErrors.set(root, error);
    }
  }
  if (scope.kind === "selected")
    records = records.filter(
      (record) =>
        requested.has(dirname(record.path)) || normal.has(dirname(record.path)),
    );
  const problems: Existing[] = [];
  const safe: InstallRecord[] = [];
  const redirected = new Set<string>();
  const unsafeRoots = new Set<string>();
  const selectedRecords = new Set(records);
  const guardedRecords = new Set([
    ...records,
    ...state.records.filter(
      (record) =>
        requested.has(dirname(record.path)) || normal.has(dirname(record.path)),
    ),
  ]);
  for (const record of guardedRecords) {
    let problem: string | undefined;
    if (
      resolve(record.path) !== record.path ||
      dirname(record.path) === record.path
    )
      problem = `安装记录位置无效：${record.path}`;
    else {
      try {
        const actual = await realpath(dirname(record.path));
        if (actual !== dirname(record.path)) {
          redirected.add(actual);
          problem = `安装记录的父目录已被重定向，请核对：${record.path}`;
        }
      } catch (error) {
        if (systemErrorCode(error) !== "ENOENT")
          problem =
            error instanceof Error
              ? error.message
              : `无法读取安装位置：${record.path}`;
      }
    }
    if (problem) {
      unsafeRoots.add(dirname(record.path));
      if (selectedRecords.has(record))
        problems.push({
          kind: "unsafe",
          present: false,
          path: record.path,
          name: record.name,
          record,
          problem,
        });
      else reportRootProblem(dirname(record.path), new Error(problem));
    } else if (selectedRecords.has(record)) safe.push(record);
  }
  for (const [root, error] of rootErrors)
    if (![...guardedRecords].some((record) => dirname(record.path) === root))
      reportRootProblem(root, error);
  const normalRoots = [...normal].filter(
    (root) => !redirected.has(root) && !unsafeRoots.has(root),
  );
  const recorded = new Set(safe.map((record) => record.path));
  const directories = [
    ...new Set([
      ...normalRoots,
      ...(scope.kind === "automatic"
        ? safe.map((record) => dirname(record.path))
        : []),
    ]),
  ].filter((root) => !unsafeRoots.has(root));
  return [
    ...problems,
    ...(await discoverAtRoots(state, directories)).filter(
      (item) =>
        (normalRoots.includes(dirname(item.path)) || recorded.has(item.path)) &&
        (item.record !== undefined ||
          sourcesForInstallation(state, item).length > 0),
    ),
  ];
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
      const records = state.records.filter(
        (record) => dirname(record.path) === root,
      );
      if (!records.length) reportRootProblem(root, error);
      for (const record of records)
        found.push({
          kind: "unsafe",
          present: false,
          path: record.path,
          name: record.name,
          record,
          problem: `无法扫描 Skill 目录 ${root}：${error instanceof Error ? error.message : String(error)}`,
        });
      continue;
    }
    for (const folder of names.sort()) {
      if (folder.startsWith(".yoho-")) continue;
      const path = join(root, folder);
      const record = state.records.find((record) => record.path === path);
      let name = record?.name ?? folder;
      let present = false;
      try {
        const info = await lstat(path);
        present = info.isDirectory() && !info.isSymbolicLink();
        if (!present) throw new Error(`目标不是普通目录：${path}`);
        if (!record) {
          const entry = join(path, "SKILL.md");
          const info = await lstat(entry);
          if (!info.isFile() || info.isSymbolicLink())
            throw new Error("Skill 入口不是普通文件");
          name = parseSkill(await readFile(entry)).name;
        }
        const backups = names.filter((candidate) =>
          isBackupFor(candidate, path),
        );
        if (backups.length)
          found.push({
            kind: "recovery",
            present,
            path,
            name,
            record,
            problem: recoveryMessage(root, backups),
          });
        else
          found.push({
            kind: "installed",
            present: true,
            identity: await directoryIdentity(path),
            path,
            name,
            record,
            problem: undefined,
          });
      } catch (error) {
        found.push({
          kind: "unsafe",
          present,
          path,
          name,
          record,
          problem: error instanceof Error ? error.message : "无法解析 Skill",
        });
      }
    }
    for (const record of state.records.filter(
      (record) =>
        dirname(record.path) === root &&
        !found.some((item) => item.path === record.path),
    )) {
      const backups = names.filter((name) => isBackupFor(name, record.path));
      if (backups.length)
        found.push({
          kind: "recovery",
          present: false,
          path: record.path,
          name: record.name,
          record,
          problem: recoveryMessage(root, backups),
        });
    }
  }
  return found;
}
function reportRootProblem(root: string, error: unknown): void {
  process.stderr.write(
    `无法扫描 Skill 目录 ${root}，已跳过此位置：${error instanceof Error ? error.message : String(error)}\n`,
  );
}
function recoveryMessage(root: string, backups: string[]): string {
  return `发现中断备份，需要核对后恢复：${backups.map((name) => join(root, name)).join("、")}`;
}

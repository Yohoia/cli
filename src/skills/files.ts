import {
  lstat,
  realpath,
  mkdir,
  mkdtemp,
  writeFile,
  rename,
  rm,
  readdir,
  readFile,
  rmdir,
} from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { systemErrorCode } from "../core/errors.js";
import { targets, failure, type Selection } from "./model.js";
import type { SkillFiles } from "./archive.js";
import { directoryLock } from "./lock.js";
export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return false;
    throw error;
  }
}
export async function directoryIdentity(path: string) {
  const { dev, ino, birthtimeNs } = await lstat(path, { bigint: true });
  return { dev, ino, birthtimeNs };
}
export async function assertDirectoryIdentity(
  path: string,
  identity: Awaited<ReturnType<typeof directoryIdentity>>,
): Promise<void> {
  try {
    const info = await lstat(path, { bigint: true });
    if (
      (await realpath(dirname(path))) !== dirname(path) ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.dev !== identity.dev ||
      info.ino !== identity.ino ||
      info.birthtimeNs !== identity.birthtimeNs
    )
      throw new Error("Directory changed");
  } catch {
    throw failure(
      "SKILL_TARGET_CHANGED",
      `目标目录已变化，保留现有内容：${path}`,
      5,
    );
  }
}
export async function removeCreatedDirectory(
  path: string,
  identity: Awaited<ReturnType<typeof directoryIdentity>>,
): Promise<void> {
  async function matches(candidate: string) {
    const current = await directoryIdentity(candidate);
    return (
      current.dev === identity.dev &&
      current.ino === identity.ino &&
      current.birthtimeNs === identity.birthtimeNs
    );
  }
  try {
    if (!(await matches(path)))
      throw failure(
        "SKILL_TARGET_CHANGED",
        `目标已被替换，保留内容：${path}`,
        5,
      );
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return;
    throw error;
  }
  const quarantine = await mkdtemp(join(dirname(path), ".yoho-rollback-"));
  const captured = join(quarantine, "target");
  try {
    await rename(path, captured);
    if (!(await matches(captured)))
      throw failure(
        "SKILL_TARGET_CHANGED",
        `回滚期间目标 ${path} 被替换，内容已保留：${captured}`,
        5,
      );
    await rm(captured, { recursive: true });
  } catch (error) {
    throw failure(
      "SKILL_ROLLBACK_FAILED",
      `无法回滚 ${path}；请核对保留位置 ${captured}：${error instanceof Error ? error.message : String(error)}`,
      5,
    );
  } finally {
    await rmdir(quarantine).catch(() => {});
  }
}
export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (systemErrorCode(error) !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalPath(parent), basename(path));
  }
}
export async function rootPaths(selection: Selection): Promise<string[]> {
  const base = await canonicalPath(
    selection.scope === "user"
      ? homedir()
      : resolve(selection.projectPath ?? process.cwd()),
  );
  return selection.target.map((target) =>
    join(base, targets[target], "skills"),
  );
}
export async function roots(selection: Selection): Promise<string[]> {
  return [
    ...new Set(
      await Promise.all((await rootPaths(selection)).map(canonicalPath)),
    ),
  ];
}
export async function localFiles(path: string): Promise<SkillFiles> {
  const files: SkillFiles = new Map();
  async function walk(dir: string, relative: string) {
    const stat = await lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw failure("SKILL_TARGET_UNSAFE", `拒绝链接或非目录目标：${dir}`);
    const entries = await readdir(dir, { withFileTypes: true });
    if (!entries.length && relative)
      files.set(relative + "/", { bytes: Buffer.alloc(0), executable: false });
    for (const entry of entries) {
      const rel = (
        relative ? `${relative}/${entry.name}` : entry.name
      ).normalize("NFC");
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else {
        const info = await lstat(full);
        if (!info.isFile() || info.isSymbolicLink())
          throw failure(
            "SKILL_TARGET_UNSAFE",
            `不支持本地链接或特殊文件：${full}`,
          );
        files.set(rel, {
          bytes: await readFile(full),
          executable: (info.mode & 0o111) !== 0,
        });
      }
    }
  }
  await walk(path, "");
  return files;
}
export async function stageFiles(
  base: string,
  files: SkillFiles,
  signal: AbortSignal,
): Promise<string> {
  await mkdir(base, { recursive: true });
  const stage = await mkdtemp(join(base, ".yoho-stage-"));
  try {
    for (const [path, file] of files) {
      signal.throwIfAborted();
      const full = join(stage, path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, file.bytes, {
        mode: file.executable ? 0o755 : 0o644,
        flag: "wx",
      });
    }
    return stage;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
export async function reserve(path: string): Promise<() => Promise<void>> {
  const lock = join(dirname(path), `.yoho-lock-${basename(path)}`);
  const release = await directoryLock(lock);
  try {
    const backups = (await readdir(dirname(path))).filter((x) =>
      isBackupFor(x, path),
    );
    if (backups.length)
      throw failure(
        "SKILL_RECOVERY_REQUIRED",
        `发现中断或清理失败留下的备份，请核对目标 ${path} 与 ${backups.map((x) => join(dirname(path), x)).join("、")} 后再重试`,
        5,
      );
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}
export function isBackupFor(name: string, path: string): boolean {
  const prefix = `.yoho-backup-${basename(path)}-`;
  return (
    name.startsWith(prefix) &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      name.slice(prefix.length),
    )
  );
}
export function backupPath(path: string) {
  return join(dirname(path), `.yoho-backup-${basename(path)}-${randomUUID()}`);
}
export { rename, rm };

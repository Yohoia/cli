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
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (systemErrorCode(error) !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent), basename(path));
  }
}
export async function roots(selection: Selection): Promise<string[]> {
  const base =
    selection.scope === "user"
      ? homedir()
      : resolve(selection.projectPath ?? process.cwd());
  return [
    ...new Set(
      await Promise.all(
        selection.target.map((target) =>
          canonical(join(base, targets[target], "skills")),
        ),
      ),
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
      x.startsWith(`.yoho-backup-${basename(path)}-`),
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
export function backupPath(path: string) {
  return join(dirname(path), `.yoho-backup-${basename(path)}-${randomUUID()}`);
}
export { rename, rm };

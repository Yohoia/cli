import { readdir, readFile, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { systemErrorCode } from "../core/errors.js";
import { roots, isBackupFor } from "./files.js";
import { parseSkill } from "./github.js";
import {
  failure,
  type SkillState,
  type InstallRecord,
  type Selection,
} from "./model.js";
export type Existing = {
  path: string;
  name: string;
  record: InstallRecord | undefined;
} & (
  | { kind: "installed"; problem: string | undefined }
  | { kind: "recovery"; problem: string }
);
export async function discover(
  state: SkillState,
  selection: Selection,
): Promise<Existing[]> {
  const found: Existing[] = [];
  for (const root of await roots(selection)) {
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

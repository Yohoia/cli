import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { configDirectory } from "../remote/config.js";
import { systemErrorCode } from "../core/errors.js";
import { stateSchema, failure, type SkillState } from "./model.js";
import { directoryLock } from "./lock.js";
export async function readState(): Promise<SkillState> {
  try {
    return stateSchema.parse(
      JSON.parse(
        await readFile(join(configDirectory(), "skills.json"), "utf8"),
      ),
    );
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT")
      return {
        version: 1,
        sources: [
          "yoho-standard-readme",
          "yoho-retro-poster",
          "yoho-speckit",
        ].map((x) => ({ repo: `yohoia/${x}` })),
        records: [],
      };
    throw failure(
      "SKILL_CONFIG_INVALID",
      "Skill 配置不可读或损坏，未重新初始化",
      2,
    );
  }
}
export async function saveState(state: SkillState) {
  const dir = configDirectory();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `skills-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(state) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, join(dir, "skills.json"));
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function withSkillState<T>(
  action: (state: SkillState) => Promise<T>,
): Promise<T> {
  const dir = configDirectory();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "skills.lock");
  const release = await directoryLock(lock);
  try {
    const state = await readState();
    return await action(state);
  } finally {
    await release();
  }
}

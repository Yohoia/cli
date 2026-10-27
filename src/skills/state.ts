import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { configDirectory } from "../core/paths.js";
import { systemErrorCode } from "../core/errors.js";
import {
  stateSchema,
  sourceSchema,
  recordSchema,
  failure,
  codeupNamespace,
  initialSkills,
  migratedRepository,
  type SkillState,
} from "./model.js";
import { directoryLock } from "./lock.js";
export async function readState(): Promise<SkillState> {
  try {
    const data: unknown = JSON.parse(
      await readFile(join(configDirectory(), "skills.json"), "utf8"),
    );
    if (z.object({ version: z.literal(1) }).safeParse(data).success) {
      const old = stateSchema.extend({ version: z.literal(1) }).parse(data);
      const sources = new Map<string, z.infer<typeof sourceSchema>>();
      for (const source of old.sources) {
        const repo = migratedRepository(source.repo);
        sources.set(repo, {
          ...source,
          repo,
          ...(repo === source.repo && !repo.startsWith(`${codeupNamespace}/`)
            ? { legacyGithub: true as const }
            : {}),
        });
      }
      return {
        version: 2,
        sources: [...sources.values()],
        records: old.records.map((record): z.infer<typeof recordSchema> => ({
          ...record,
          repo: migratedRepository(record.repo),
        })),
      };
    }
    return stateSchema.parse(data);
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT")
      return {
        version: 2,
        sources: initialSkills.map((x) => ({
          repo: `${codeupNamespace}/${x}`,
        })),
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
    await saveState(state);
    return await action(state);
  } finally {
    await release();
  }
}

import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { systemErrorCode } from "../core/errors.js";
import { failure } from "./model.js";
const ownerSchema = z.object({
  pid: z.number().int().positive(),
  nonce: z.string().uuid(),
});
async function owner(path: string) {
  try {
    return ownerSchema.parse(
      JSON.parse(await readFile(join(path, "owner.json"), "utf8")),
    );
  } catch {
    return undefined;
  }
}
async function stale(path: string) {
  const current = await owner(path);
  if (current) {
    try {
      process.kill(current.pid, 0);
      return false;
    } catch (error) {
      return systemErrorCode(error) === "ESRCH";
    }
  }
  try {
    return Date.now() - (await stat(path)).mtimeMs > 60000;
  } catch (error) {
    if (systemErrorCode(error) === "ENOENT") return true;
    throw error;
  }
}
export async function directoryLock(
  path: string,
): Promise<() => Promise<void>> {
  const identity = { pid: process.pid, nonce: randomUUID() };
  const busy = () =>
    failure("SKILL_BUSY", `另一个 Skill 操作持有锁：${path}，请稍后重试`, 5);
  try {
    await mkdir(path);
  } catch (error) {
    if (systemErrorCode(error) !== "EEXIST") throw error;
    const reclaim = path + ".reclaim";
    try {
      await mkdir(reclaim);
    } catch (error) {
      if (systemErrorCode(error) === "EEXIST") {
        if (await stale(reclaim))
          throw failure(
            "SKILL_RECOVERY_REQUIRED",
            `上次锁回收已中断。确认没有其他 Skill 操作后，将回收门目录改名留存，再重试：${reclaim}；保留 Skill 内容和安装记录`,
            5,
          );
        throw busy();
      }
      throw error;
    }
    try {
      await writeFile(join(reclaim, "owner.json"), JSON.stringify(identity), {
        flag: "wx",
        mode: 0o600,
      });
      if (!(await stale(path))) throw busy();
      await rm(path, { recursive: true, force: true });
      try {
        await mkdir(path);
      } catch (error) {
        if (systemErrorCode(error) === "EEXIST") throw busy();
        throw error;
      }
    } finally {
      const current = await owner(reclaim);
      if (!current || current.nonce === identity.nonce)
        await rm(reclaim, { recursive: true, force: true });
    }
  }
  try {
    await writeFile(join(path, "owner.json"), JSON.stringify(identity), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
  return async () => {
    if ((await owner(path))?.nonce === identity.nonce)
      await rm(path, { recursive: true, force: true });
  };
}

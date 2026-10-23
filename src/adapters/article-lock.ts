import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { lock } from "proper-lockfile";
import { AppError, systemErrorCode } from "../core/errors.js";

export async function acquireArticleLock({
  path,
  signal,
}: {
  path: string;
  signal: AbortSignal;
}) {
  const stem = path.replace(/\.mdx?$/, "");
  const lockfilePath = join(
    dirname(stem),
    `.yoho-lock-${createHash("sha256").update(stem).digest("hex")}.lock`,
  );
  const deadline = Date.now() + 5_000;
  let compromised = false;
  while (true) {
    signal.throwIfAborted();
    try {
      const release = await lock(path, {
        realpath: false,
        lockfilePath,
        stale: 10_000,
        retries: 0,
        onCompromised: () => {
          compromised = true;
        },
      });
      return {
        release,
        assertHeld() {
          signal.throwIfAborted();
          if (compromised)
            throw new AppError({
              code: "ARTICLE_CONFLICT",
              message: "文章锁已失效，请重新读取后重试",
              exitCode: 3,
            });
        },
      };
    } catch (error) {
      if (systemErrorCode(error) !== "ELOCKED") throw error;
      if (Date.now() >= deadline)
        throw new AppError({
          code: "ARTICLE_CONFLICT",
          message: "文章正在被其他进程修改，请稍后重试",
          exitCode: 3,
        });
      await setTimeout(25, undefined, { signal });
    }
  }
}

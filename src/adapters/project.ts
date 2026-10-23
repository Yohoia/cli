import { realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { AppError, systemErrorCode } from "../core/errors.js";

export async function resolveContentRoot({ cwd, project }: { cwd: string; project: string | undefined }): Promise<string> {
  let current = resolve(cwd, project ?? ".");
  while (true) {
    const content = join(current, "content", "blog");
    try {
      if ((await stat(content)).isDirectory()) return realpath(content);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(systemErrorCode(error) ?? "")) throw error;
    }
    const parent = dirname(current);
    if (project !== undefined || parent === current) {
      throw new AppError({ code: "PROJECT_NOT_FOUND", message: `找不到博客项目：${current}，请使用 --project 指定博客项目`, exitCode: 2 });
    }
    current = parent;
  }
}

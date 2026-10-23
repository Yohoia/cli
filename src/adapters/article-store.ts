import { open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { articleIdSchema } from "../core/articles.js";
import type { Article, ArticleId, ArticleStore } from "../core/articles.js";
import { AppError, systemErrorCode } from "../core/errors.js";
import { parseArticleSource, replaceArticleTitle } from "./markdown.js";

export function createFileArticleStore({ root, signal }: { root: string; signal: AbortSignal }): ArticleStore {
  async function readSource(path: string): Promise<string> {
    const bytes = await readFile(path, { signal });
    const source = bytes.toString("utf8");
    if (!Buffer.from(source, "utf8").equals(bytes)) {
      throw new AppError({ code: "ARTICLE_INVALID", message: `文章不是有效 UTF-8 文件：${path}`, exitCode: 3 });
    }
    return source;
  }

  async function resolveArticlePath(id: ArticleId): Promise<string> {
    const candidates: string[] = [];
    for (const extension of [".md", ".mdx"]) {
      try {
        const path = await realpath(join(root, id + extension));
        const inside = relative(root, path);
        if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
          throw new AppError({ code: "PATH_OUTSIDE_CONTENT", message: `文章超出内容目录：${id}`, exitCode: 2 });
        }
        if (!(await stat(path)).isFile()) {
          throw new AppError({ code: "ARTICLE_INVALID", message: `文章不是普通文件：${id}`, exitCode: 3 });
        }
        candidates.push(path);
      } catch (error) {
        if (systemErrorCode(error) !== "ENOENT") throw error;
      }
    }
    if (candidates.length > 1) throw new AppError({ code: "ARTICLE_ID_AMBIGUOUS", message: `文章标识对应多个文件：${id}`, exitCode: 3 });
    const path = candidates[0];
    if (!path) throw new AppError({ code: "ARTICLE_NOT_FOUND", message: `找不到指定文章：${id}`, exitCode: 3 });
    return path;
  }

  return {
    async edit({ id, decide }) {
      signal.throwIfAborted();
      const path = await resolveArticlePath(id);
      const source = await readSource(path);
      const current = { id, path, ...parseArticleSource({ source, path }) };
      const change = decide(current);
      if (change.kind === "unchanged") return { id, title: current.metadata.title, revision: current.revision, changed: false };
      const updated = replaceArticleTitle({ source, path, title: change.title });
      const next = parseArticleSource({ source: updated, path });
      if (!isDeepStrictEqual({ ...next.metadata, title: current.metadata.title }, current.metadata) || next.content !== current.content) {
        throw new AppError({ code: "ARTICLE_INVALID", message: `标题与其他内容存在关联，无法独立修改：${path}`, exitCode: 3 });
      }
      const mode = (await stat(path)).mode & 0o777;
      const temporary = join(dirname(path), `.${basename(path)}.yoho-${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(updated, { encoding: "utf8", signal });
          await file.chmod(mode);
          await file.sync();
        } finally {
          await file.close();
        }
        signal.throwIfAborted();
        if (await resolveArticlePath(id) !== path || await readSource(path) !== source) {
          throw new AppError({ code: "ARTICLE_CONFLICT", message: `文章在修改期间发生变化，请重新读取：${id}`, exitCode: 3 });
        }
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
      return { id, title: change.title, revision: next.revision, changed: true };
    },
    async read({ id }) {
      signal.throwIfAborted();
      const path = await resolveArticlePath(id);
      const source = await readSource(path);
      return { id, path, ...parseArticleSource({ source, path }) };
    },
    async list() {
      const articles: Article[] = [];
      async function walk(directory: string): Promise<void> {
        signal.throwIfAborted();
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile() && /\.mdx?$/.test(entry.name)) {
            const source = await readSource(path);
            const id = articleIdSchema.parse(relative(root, path).replace(/\.mdx?$/, ""));
            articles.push({ id, path, ...parseArticleSource({ source, path }) });
          }
        }
      }
      await walk(root);
      return articles;
    },
  };
}

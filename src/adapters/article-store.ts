import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { articleIdSchema } from "../core/articles.js";
import type { Article, ArticleId, ArticleStore } from "../core/articles.js";
import { AppError, systemErrorCode } from "../core/errors.js";
import { parseArticleSource } from "./markdown.js";

export function createFileArticleStore({ root, signal }: { root: string; signal: AbortSignal }): ArticleStore {
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
    async read({ id }) {
      signal.throwIfAborted();
      const path = await resolveArticlePath(id);
      const source = await readFile(path, { encoding: "utf8", signal });
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
            const source = await readFile(path, { encoding: "utf8", signal });
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

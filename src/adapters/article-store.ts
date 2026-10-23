import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Article, ArticleStore } from "../core/articles.js";
import { parseArticleSource } from "./markdown.js";

export function createFileArticleStore({ root, signal }: { root: string; signal: AbortSignal }): ArticleStore {
  return {
    async list() {
      const articles: Article[] = [];
      async function walk(directory: string): Promise<void> {
        signal.throwIfAborted();
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile() && /\.mdx?$/.test(entry.name)) {
            const source = await readFile(path, { encoding: "utf8", signal });
            articles.push({ id: relative(root, path).replace(/\.mdx?$/, ""), path, ...parseArticleSource({ source, path }) });
          }
        }
      }
      await walk(root);
      return articles;
    },
  };
}

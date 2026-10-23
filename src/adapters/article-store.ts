import {
  open,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { articleIdSchema } from "../core/articles.js";
import type { Article, ArticleId, ArticleStore } from "../core/articles.js";
import { AppError, systemErrorCode } from "../core/errors.js";
import {
  parseArticleSource,
  replaceArticleTitle,
  replaceArticleMetadata,
  replaceArticleBody,
} from "./markdown.js";
import { acquireArticleLock } from "./article-lock.js";

export function createFileArticleStore({
  root,
  signal,
}: {
  root: string;
  signal: AbortSignal;
}): ArticleStore {
  function ensureContained(path: string): void {
    const inside = relative(root, path);
    if (
      inside === ".." ||
      inside.startsWith(`..${sep}`) ||
      isAbsolute(inside)
    ) {
      throw new AppError({
        code: "PATH_OUTSIDE_CONTENT",
        message: `文章超出内容目录：${path}`,
        exitCode: 2,
      });
    }
  }

  async function readSource(path: string): Promise<string> {
    const bytes = await readFile(path, { signal });
    const source = bytes.toString("utf8");
    if (!Buffer.from(source, "utf8").equals(bytes)) {
      throw new AppError({
        code: "ARTICLE_INVALID",
        message: `文章不是有效 UTF-8 文件：${path}`,
        exitCode: 3,
      });
    }
    return source;
  }

  async function resolveArticlePath(id: ArticleId): Promise<string> {
    const candidates: string[] = [];
    for (const extension of [".md", ".mdx"]) {
      try {
        const path = await realpath(join(root, id + extension));
        ensureContained(path);
        if (!(await stat(path)).isFile()) {
          throw new AppError({
            code: "ARTICLE_INVALID",
            message: `文章不是普通文件：${id}`,
            exitCode: 3,
          });
        }
        candidates.push(path);
      } catch (error) {
        if (systemErrorCode(error) !== "ENOENT") throw error;
      }
    }
    if (candidates.length > 1)
      throw new AppError({
        code: "ARTICLE_ID_AMBIGUOUS",
        message: `文章标识对应多个文件：${id}`,
        exitCode: 3,
      });
    const path = candidates[0];
    if (!path)
      throw new AppError({
        code: "ARTICLE_NOT_FOUND",
        message: `找不到指定文章：${id}`,
        exitCode: 3,
      });
    return path;
  }

  async function rejectLinkedDeletionPath(id: ArticleId): Promise<void> {
    async function checkBoundary(path: string): Promise<void> {
      try {
        ensureContained(await realpath(path));
      } catch (error) {
        if (
          !["ENOENT", "ENOTDIR", "ELOOP"].includes(systemErrorCode(error) ?? "")
        )
          throw error;
      }
    }
    for (const extension of [".md", ".mdx"]) {
      const target = join(root, id + extension);
      await checkBoundary(target);
      let path = root;
      const segments = relative(root, target).split(sep);
      for (const [index, segment] of segments.entries()) {
        signal.throwIfAborted();
        path = join(path, segment);
        await checkBoundary(path);
        let info;
        try {
          info = await lstat(path);
        } catch (error) {
          if (systemErrorCode(error) === "ENOENT") break;
          throw error;
        }
        if (
          info.isSymbolicLink() ||
          (index < segments.length - 1 && !info.isDirectory())
        ) {
          throw new AppError({
            code: "ARTICLE_INVALID",
            message: `删除目标不能包含符号链接或非目录父路径：${path}`,
            exitCode: 3,
          });
        }
      }
    }
  }

  return {
    async readForDeletion({ id }) {
      signal.throwIfAborted();
      await rejectLinkedDeletionPath(id);
      const path = await resolveArticlePath(id);
      const source = await readSource(path);
      return { id, path, ...parseArticleSource({ source, path }) };
    },
    async edit({ id, decide }) {
      signal.throwIfAborted();
      const path = await resolveArticlePath(id);
      const lease = await acquireArticleLock({ path, signal });
      try {
        lease.assertHeld();
        if ((await resolveArticlePath(id)) !== path) {
          throw new AppError({
            code: "ARTICLE_CONFLICT",
            message: `文章位置发生变化，请重新读取：${id}`,
            exitCode: 3,
          });
        }
        const source = await readSource(path);
        const current = { id, path, ...parseArticleSource({ source, path }) };
        lease.assertHeld();
        const changes = decide(current);
        let updated = source;
        let title = current.metadata.title;
        const expectedMetadata = { ...current.metadata };
        let content = current.content;
        for (const change of changes) {
          switch (change.kind) {
            case "title":
              title = change.title;
              expectedMetadata.title = title;
              if (title !== current.metadata.title)
                updated = replaceArticleTitle({ source: updated, path, title });
              break;
            case "tags":
              expectedMetadata.tags = change.tags;
              if (!isDeepStrictEqual(change.tags, current.metadata.tags))
                updated = replaceArticleMetadata({
                  source: updated,
                  path,
                  field: "tags",
                  value: change.tags,
                });
              break;
            case "description":
              expectedMetadata.description = change.description;
              if (change.description !== current.metadata.description)
                updated = replaceArticleMetadata({
                  source: updated,
                  path,
                  field: "description",
                  value: change.description,
                });
              break;
            case "body": {
              const [inputStat, targetStat] = await Promise.all([
                stat(change.sourcePath),
                stat(path),
              ]);
              if (
                inputStat.dev === targetStat.dev &&
                inputStat.ino === targetStat.ino
              ) {
                throw new AppError({
                  code: "INVALID_ARGUMENT",
                  message: `正文输入不能与目标文章是同一文件：${id}`,
                  exitCode: 2,
                });
              }
              content = change.content;
              if (content !== current.content)
                updated = replaceArticleBody({
                  source: updated,
                  path,
                  content,
                });
              break;
            }
            default: {
              const exhaustive: never = change;
              return exhaustive;
            }
          }
        }
        if (updated === source)
          return { id, title, revision: current.revision, changed: false };
        const next = parseArticleSource({ source: updated, path });
        if (
          !isDeepStrictEqual(next.metadata, expectedMetadata) ||
          next.content !== content
        ) {
          throw new AppError({
            code: "ARTICLE_INVALID",
            message: `指定字段与其他内容存在关联，无法独立修改：${path}`,
            exitCode: 3,
          });
        }
        const mode = (await stat(path)).mode & 0o777;
        const temporary = join(
          dirname(path),
          `.${basename(path)}.yoho-${randomUUID()}.tmp`,
        );
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
          if (
            (await resolveArticlePath(id)) !== path ||
            (await readSource(path)) !== source
          ) {
            throw new AppError({
              code: "ARTICLE_CONFLICT",
              message: `文章在修改期间发生变化，请重新读取：${id}`,
              exitCode: 3,
            });
          }
          lease.assertHeld();
          await rename(temporary, path);
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
        return {
          id,
          title,
          revision: next.revision,
          changed: true,
        };
      } finally {
        await lease.release().catch(() => undefined);
      }
    },
    async read({ id }) {
      signal.throwIfAborted();
      const path = await resolveArticlePath(id);
      const source = await readSource(path);
      return { id, path, ...parseArticleSource({ source, path }) };
    },
    async list() {
      const articles: Article[] = [];
      const ids = new Set<ArticleId>();
      async function walk(
        directory: string,
        ancestors: Set<string>,
      ): Promise<void> {
        signal.throwIfAborted();
        const canonical = await realpath(directory);
        ensureContained(canonical);
        if (ancestors.has(canonical))
          throw new AppError({
            code: "ARTICLE_INVALID",
            message: `内容目录包含循环链接：${directory}`,
            exitCode: 3,
          });
        const nextAncestors = new Set([...ancestors, canonical]);
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const logical = join(directory, entry.name);
          const path = await realpath(logical);
          ensureContained(path);
          const kind = entry.isSymbolicLink() ? await stat(path) : entry;
          if (kind.isDirectory()) await walk(logical, nextAncestors);
          else if (kind.isFile() && /\.mdx?$/.test(entry.name)) {
            const source = await readSource(path);
            const parsedId = articleIdSchema.safeParse(
              relative(root, logical).replace(/\.mdx?$/, ""),
            );
            if (!parsedId.success)
              throw new AppError({
                code: "ARTICLE_INVALID",
                message: `文章文件名无法形成有效标识：${logical}`,
                exitCode: 3,
              });
            const id = parsedId.data;
            if (ids.has(id))
              throw new AppError({
                code: "ARTICLE_ID_AMBIGUOUS",
                message: `文章标识对应多个文件：${id}`,
                exitCode: 3,
              });
            ids.add(id);
            articles.push({
              id,
              path,
              ...parseArticleSource({ source, path }),
            });
          }
        }
      }
      await walk(root, new Set());
      return articles;
    },
  };
}

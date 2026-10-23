import { parseDocument } from "yaml";
import { articleMetadataSchema } from "../core/articles.js";
import { AppError } from "../core/errors.js";

export function parseArticleSource({ source, path }: { source: string; path: string }) {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(source);
  const closing = opening ? /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(source.slice(opening[0].length)) : null;
  if (!opening || !closing) {
    throw new AppError({ code: "ARTICLE_INVALID", message: `文章缺少完整 frontmatter：${path}`, exitCode: 3 });
  }
  const headerStart = opening[0].length;
  const header = source.slice(headerStart, headerStart + closing.index);
  const document = parseDocument(header, { keepSourceTokens: true, merge: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new AppError({ code: "ARTICLE_INVALID", message: `文章元数据损坏：${path}，${document.errors[0]?.message}`, exitCode: 3 });
  }
  let metadata: unknown;
  try {
    metadata = document.toJS({ maxAliasCount: 100 });
  } catch {
    throw new AppError({ code: "ARTICLE_INVALID", message: `无法解析文章元数据：${path}`, exitCode: 3 });
  }
  const parsed = articleMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    throw new AppError({ code: "ARTICLE_INVALID", message: `文章元数据无效：${path}，${parsed.error.message}`, exitCode: 3 });
  }
  return {
    metadata: parsed.data,
    content: source.slice(headerStart + closing.index + closing[0].length),
  };
}

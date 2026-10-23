import { isAlias, isScalar, parseDocument } from "yaml";
import { createHash } from "node:crypto";
import { articleMetadataSchema, articleRevisionSchema } from "../core/articles.js";
import { AppError } from "../core/errors.js";

function parseHeader({ source, path }: { source: string; path: string }) {
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
  return { document, headerStart, contentStart: headerStart + closing.index + closing[0].length };
}

export function parseArticleSource({ source, path }: { source: string; path: string }) {
  const { document, contentStart } = parseHeader({ source, path });
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
  try {
    JSON.stringify(parsed.data);
  } catch {
    throw new AppError({ code: "ARTICLE_INVALID", message: `文章元数据无法表示为 JSON：${path}`, exitCode: 3 });
  }
  return {
    metadata: parsed.data,
    content: source.slice(contentStart),
    revision: articleRevisionSchema.parse(`sha256:${createHash("sha256").update(source).digest("hex")}`),
  };
}

export function replaceArticleTitle({ source, path, title }: { source: string; path: string; title: string }): string {
  const { document, headerStart } = parseHeader({ source, path });
  const node: unknown = document.get("title", true);
  if ((!isScalar(node) && !isAlias(node)) || !node.range) {
    throw new AppError({ code: "ARTICLE_INVALID", message: `无法独立定位标题字段：${path}`, exitCode: 3 });
  }
  const [start, end] = node.range;
  let suffix = "";
  if (node.srcToken?.type === "block-scalar") {
    suffix = node.srcToken.props.filter(token => token.type !== "block-scalar-header").map(token => "source" in token ? token.source : "").join("");
    const trailing = /((?:[ \t]*\r?\n)+)$/.exec(node.srcToken.source)?.[0] ?? "";
    suffix += trailing.replace(/^\r?\n/, "");
  }
  return source.slice(0, headerStart + start) + JSON.stringify(title) + suffix + source.slice(headerStart + end);
}

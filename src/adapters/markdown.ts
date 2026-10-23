import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { createHash } from "node:crypto";
import matter from "gray-matter";
import { z } from "zod";
import {
  articleMetadataSchema,
  articleRevisionSchema,
} from "../core/articles.js";
import { AppError } from "../core/errors.js";

const rawMetadataSchema = z.custom<Record<string, unknown>>(
  (value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value),
);

function parseHeader({ source, path }: { source: string; path: string }) {
  const opening = /^(?:\uFEFF)?---[ \t]*\r?\n/.exec(source);
  const closing = opening
    ? /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(source.slice(opening[0].length))
    : null;
  if (!opening || !closing) {
    throw new AppError({
      code: "ARTICLE_INVALID",
      message: `文章缺少完整 frontmatter：${path}`,
      exitCode: 3,
    });
  }
  const headerStart = opening[0].length;
  const header = source.slice(headerStart, headerStart + closing.index);
  const document = parseDocument(header, {
    keepSourceTokens: true,
    merge: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new AppError({
      code: "ARTICLE_INVALID",
      message: `文章元数据损坏：${path}，${document.errors[0]?.message}`,
      exitCode: 3,
    });
  }
  return {
    document,
    headerStart,
    headerEnd: headerStart + closing.index,
    contentStart: headerStart + closing.index + closing[0].length,
  };
}

export function parseArticleSource({
  source,
  path,
}: {
  source: string;
  path: string;
}) {
  const { document, contentStart } = parseHeader({ source, path });
  let metadata: unknown;
  try {
    document.toJS({ maxAliasCount: 100 });
    metadata = matter(source).data;
  } catch {
    throw new AppError({
      code: "ARTICLE_INVALID",
      message: `无法解析文章元数据：${path}`,
      exitCode: 3,
    });
  }
  const raw = rawMetadataSchema.safeParse(metadata);
  if (!raw.success) {
    throw new AppError({
      code: "ARTICLE_INVALID",
      message: `文章元数据必须是对象：${path}`,
      exitCode: 3,
    });
  }
  const parsed = articleMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    throw new AppError({
      code: "ARTICLE_INVALID",
      message: `文章元数据无效：${path}，${parsed.error.message}`,
      exitCode: 3,
    });
  }
  const preserved = { ...raw.data, ...parsed.data };
  try {
    JSON.stringify(preserved, (_key: string, value: unknown) => {
      if (typeof value === "number" && !Number.isFinite(value))
        throw new Error("Non-finite YAML number");
      return value;
    });
  } catch {
    throw new AppError({
      code: "ARTICLE_INVALID",
      message: `文章元数据无法表示为 JSON：${path}`,
      exitCode: 3,
    });
  }
  return {
    metadata: preserved,
    content: source.slice(contentStart),
    revision: articleRevisionSchema.parse(
      `sha256:${createHash("sha256").update(source).digest("hex")}`,
    ),
  };
}

export function replaceArticleMetadata({
  source,
  path,
  field,
  value,
}: {
  source: string;
  path: string;
} & (
  | { field: "title" | "description" | "status"; value: string }
  | { field: "tags"; value: string[] }
  | { field: "draft"; value: boolean }
)): string {
  const { document, headerStart, headerEnd } = parseHeader({ source, path });
  const node: unknown = document.get(field, true);
  if (node === undefined && isMap(document.contents)) {
    if (document.contents.flow && document.contents.range) {
      const closing = headerStart + document.contents.range[1] - 1;
      const prefix = source.slice(0, closing);
      return (
        prefix +
        (/,\s*$/.test(prefix) ? " " : ", ") +
        `${field}: ${JSON.stringify(value)}` +
        source.slice(closing)
      );
    }
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    return (
      source.slice(0, headerEnd) +
      `${field}: ${JSON.stringify(value)}${newline}` +
      source.slice(headerEnd)
    );
  }
  if ((!isScalar(node) && !isAlias(node) && !isSeq(node)) || !node.range) {
    throw new AppError({
      code: "ARTICLE_INVALID",
      message: `无法独立定位指定字段：${path}`,
      exitCode: 3,
    });
  }
  const [start, end] = node.range;
  let suffix = "";
  if (node.srcToken?.type === "block-scalar") {
    suffix = node.srcToken.props
      .filter((token) => token.type !== "block-scalar-header")
      .map((token) => ("source" in token ? token.source : ""))
      .join("");
    const trailing =
      /((?:[ \t]*\r?\n)+)$/.exec(node.srcToken.source)?.[0] ?? "";
    suffix += trailing.replace(/^\r?\n/, "");
  }
  return (
    source.slice(0, headerStart + start) +
    JSON.stringify(value) +
    (isSeq(node) && !node.flow
      ? source.includes("\r\n")
        ? "\r\n"
        : "\n"
      : "") +
    suffix +
    source.slice(headerStart + end)
  );
}

export function replaceArticleBody({
  source,
  path,
  content,
}: {
  source: string;
  path: string;
  content: string;
}): string {
  const { contentStart } = parseHeader({ source, path });
  const prefix = source.slice(0, contentStart);
  const separator =
    content !== "" && !prefix.endsWith("\n")
      ? source.includes("\r\n")
        ? "\r\n"
        : "\n"
      : "";
  return prefix + separator + content;
}

export function replaceArticleTitle(input: {
  source: string;
  path: string;
  title: string;
}): string {
  return replaceArticleMetadata({
    ...input,
    field: "title",
    value: input.title,
  });
}

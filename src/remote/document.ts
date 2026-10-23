import { open, stat, realpath } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root, Nodes } from "mdast";
import { z } from "zod";
import { AppError } from "../core/errors.js";

function invalid(message: string): never {
  throw new AppError({ code: "ARTICLE_INVALID", message, exitCode: 3 });
}
function plain(node: Nodes): string {
  if (node.type === "code" || node.type === "html") return "";
  if ("value" in node) return node.value;
  if (node.type === "image") return node.alt ?? "";
  if ("children" in node) return node.children.map(plain).join(" ");
  return "";
}
function walk(node: Nodes, visit: (node: Nodes) => void): void {
  visit(node);
  if ("children" in node) for (const child of node.children) walk(child, visit);
}
export function isRemoteResource(url: string): boolean {
  return (
    /^https?:\/\//i.test(url) ||
    /^\/v1\/assets\/[0-9a-f-]+\/content(?:[?#].*)?$/i.test(url)
  );
}
type Replacement = { start: number; end: number };
type LocalImage = {
  path: string;
  hash: string;
  mime: string;
  bytes: Buffer;
  references: Replacement[];
};
function destination(content: string, node: Nodes): Replacement {
  const start = node.position?.start.offset,
    end = node.position?.end.offset;
  if (start === undefined || end === undefined) invalid("无法定位图片引用");
  const literal = content.slice(start, end);
  let depth = 0,
    index = 1;
  for (; index < literal.length; index++) {
    const character = literal[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (character === "[") depth++;
    if (character === "]" && --depth === 0) {
      index += 2;
      break;
    }
  }
  while (/\s/.test(literal[index] ?? "X")) index++;
  const angle = literal[index] === "<";
  if (angle) index++;
  const from = index;
  let parentheses = 0;
  for (; index < literal.length; index++) {
    const character = literal[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (angle && character === ">") break;
    if (!angle) {
      if (character === "(") parentheses++;
      if (character === ")") {
        if (parentheses === 0) break;
        parentheses--;
      }
      if (/\s/.test(character ?? "X") && parentheses === 0) break;
    }
  }
  return { start: start + from, end: start + index };
}
async function localImages(
  tree: Root,
  content: string,
  documentPath: string,
  signal: AbortSignal,
): Promise<LocalImage[]> {
  const images = new Map<string, LocalImage>();
  const local: Extract<Nodes, { type: "image" }>[] = [];
  walk(tree, (node) => {
    if (
      node.type === "image" &&
      !isRemoteResource(node.url) &&
      !node.url.startsWith("#")
    )
      local.push(node);
    if (
      (node.type === "link" || node.type === "definition") &&
      !isRemoteResource(node.url) &&
      !node.url.startsWith("#") &&
      !/^(mailto|tel):/i.test(node.url)
    )
      invalid(`不支持的本地资源引用：${node.url}`);
    if (node.type === "html")
      for (const match of node.value.matchAll(
        /(?:src|href)\s*=\s*(?:["']([^"']+)["']|([^\s>]+))/gi,
      )) {
        const url = match[1] ?? match[2];
        if (url && !isRemoteResource(url) && !url.startsWith("#"))
          invalid(`不支持的本地 HTML 资源：${url}`);
      }
  });
  for (const node of local) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(node.url))
      invalid(`不支持的图片地址：${node.url}`);
    let decoded: string;
    try {
      decoded = decodeURIComponent(node.url.split(/[?#]/u)[0] ?? "");
    } catch {
      invalid(`图片路径编码无效：${node.url}`);
    }
    const path = await realpath(resolve(dirname(documentPath), decoded)).catch(
      () => invalid(`图片不存在：${node.url}`),
    );
    const reference = destination(content, node);
    const existing = images.get(path);
    if (existing) {
      existing.references.push(reference);
      continue;
    }
    const info = await stat(path);
    if (!info.isFile() || info.size > 5 * 1024 * 1024)
      invalid(`图片必须为普通文件，单张不超过 5 MiB：${node.url}`);
    const file = await open(path, "r");
    let bytes: Buffer;
    try {
      if (!(await file.stat()).isFile())
        invalid(`图片不是普通文件：${node.url}`);
      bytes = await file.readFile({ signal });
    } finally {
      await file.close();
    }
    if (bytes.length > 5 * 1024 * 1024) invalid(`图片超过 5 MiB：${node.url}`);
    const mime = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? "image/jpeg"
        : bytes.toString("ascii", 0, 4) === "RIFF" &&
            bytes.toString("ascii", 8, 12) === "WEBP"
          ? "image/webp"
          : null;
    if (!mime) invalid(`图片格式无效，仅支持 JPEG、PNG、WebP：${node.url}`);
    images.set(path, {
      path,
      hash: createHash("sha256").update(bytes).digest("hex"),
      mime,
      bytes,
      references: [reference],
    });
  }
  return [...images.values()];
}
const metadataSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  language: z.enum(["zh", "en"]).optional(),
});
export async function readDocument(path: string, signal: AbortSignal) {
  const absolute = resolve(path);
  if (extname(absolute).toLowerCase() !== ".md")
    invalid("新增只接受单个 .md 文档路径");
  if (!(await stat(absolute)).isFile()) invalid("文档必须为普通文件");
  const handle = await open(absolute, "r");
  let bytes: Buffer;
  try {
    if (!(await handle.stat()).isFile()) invalid("文档必须为普通文件");
    bytes = await handle.readFile({ signal });
  } finally {
    await handle.close();
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid("文档必须是有效 UTF-8");
  }
  let data: Record<string, unknown> = {};
  let content = source;
  if (/^---[^\s-]/u.test(source))
    invalid("仅支持 YAML frontmatter，不能指定其他解析语言");
  if (/^---[ \t]*(?:\r?\n|$)/u.test(source)) {
    const matched =
      /^---[ \t]*\r?\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/mu.exec(
        source,
      );
    if (!matched || matched.index !== 0)
      invalid("YAML frontmatter 缺少结束分隔符");
    try {
      data = z
        .record(z.string(), z.unknown())
        .parse(parseYaml(matched[1] ?? "") ?? {});
    } catch {
      invalid("YAML frontmatter 必须是有效字段映射");
    }
    content = source.slice(matched[0].length);
  }
  const fields = metadataSchema.safeParse(data);
  if (!fields.success)
    invalid(
      "frontmatter 的 title、description 必须是文本，language 只能为 zh 或 en",
    );
  if (!content.trim()) invalid("正文不能为空；未上传任何图片或文章");
  const tree = unified().use(remarkParse).parse(content);
  let heading = "";
  walk(tree, (node) => {
    if (!heading && node.type === "heading" && node.depth === 1)
      heading = plain(node).trim();
  });
  const title = (
    fields.data.title?.trim() ||
    heading ||
    basename(absolute, extname(absolute))
  ).trim();
  if (!title || /[\r\n]/.test(title) || title.length > 200)
    invalid("标题必须为非空单行文本，且不超过 200 字符");
  const description =
    fields.data.description?.trim() ||
    plain(tree).replace(/\s+/gu, " ").trim().slice(0, 500);
  if (!description || description.length > 500)
    invalid("无法生成有效摘要，请提供不超过 500 字符的 description");
  const images = await localImages(tree, content, absolute, signal);
  const ignored = Object.keys(data).filter(
    (key) => !["title", "description", "language"].includes(key),
  );
  if (ignored.length)
    process.stderr.write(`未导入元数据：${ignored.join("、")}\n`);
  return {
    payload: {
      title,
      description,
      language: fields.data.language ?? "zh",
      content,
      format: "md",
    },
    images,
    fingerprint: createHash("sha256")
      .update(bytes)
      .update(images.map((image) => image.hash).join(":"))
      .digest("hex"),
  };
}

import { open, stat, realpath } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root, Nodes } from "mdast";
import { parse, postprocess, preprocess } from "micromark";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
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
function imageDestinations(content: string): Map<number, Replacement> {
  const destinations = new Map<number, Replacement>();
  const parents: { type: "image" | "link"; start: number }[] = [];
  const events = postprocess(
    parse()
      .document()
      .write(preprocess()(content, undefined, true)),
  );
  for (const [phase, token] of events) {
    if (token.type === "image" || token.type === "link") {
      if (phase === "enter")
        parents.push({ type: token.type, start: token.start.offset });
      else parents.pop();
    } else if (
      phase === "enter" &&
      token.type === "resourceDestinationString"
    ) {
      const parent = parents.at(-1);
      if (parent?.type === "image")
        destinations.set(parent.start, {
          start: token.start.offset,
          end: token.end.offset,
        });
    }
  }
  return destinations;
}

function* srcsetUrls(value: string): Generator<string> {
  let position = 0;
  while (position < value.length) {
    while (/[\t\n\f\r ,]/.test(value[position] ?? "X")) position++;
    const start = position;
    while (
      position < value.length &&
      !/[\t\n\f\r ]/.test(value[position] ?? "")
    )
      position++;
    const url = value.slice(start, position);
    if (!url) break;
    yield url.replace(/,+$/, "");
    if (url.endsWith(",")) continue;
    let parentheses = 0;
    while (position < value.length) {
      const character = value[position++];
      if (character === "(") parentheses++;
      else if (character === ")") parentheses = Math.max(0, parentheses - 1);
      else if (character === "," && parentheses === 0) break;
    }
  }
}

function validateHtmlResources(html: string) {
  function validate(url: string) {
    const value = url.trim();
    if (value && !isRemoteResource(value) && !value.startsWith("#"))
      invalid(`不支持的本地 HTML 资源：${value}`);
  }
  function visit(node: DefaultTreeAdapterMap["node"]) {
    if ("tagName" in node) {
      for (const attribute of node.attrs) {
        if (
          ["src", "href"].includes(attribute.name) ||
          (attribute.name === "poster" && node.tagName === "video") ||
          (attribute.name === "data" && node.tagName === "object")
        )
          validate(attribute.value);
        if (["srcset", "imagesrcset"].includes(attribute.name))
          for (const url of srcsetUrls(attribute.value)) validate(url);
      }
      if (["pre", "code", "script", "style", "template"].includes(node.tagName))
        return;
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  }
  visit(parseFragment(html));
}
async function localImages(
  tree: Root,
  content: string,
  documentPath: string,
  signal: AbortSignal,
): Promise<LocalImage[]> {
  const images = new Map<string, LocalImage>();
  const local: Extract<Nodes, { type: "image" }>[] = [];
  const html: string[] = [];
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
    if (node.type === "html") html.push(node.value);
  });
  validateHtmlResources(html.join("\n"));
  const destinations = local.length
    ? imageDestinations(content)
    : new Map<number, Replacement>();
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
    const start = node.position?.start.offset;
    const reference = start === undefined ? undefined : destinations.get(start);
    if (!reference) invalid("无法定位图片引用");
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

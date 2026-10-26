import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import {
  metadataSchema,
  failure,
  type Metadata,
  type Source,
  type CatalogItem,
} from "./model.js";
import { saveState } from "./state.js";
import type { SkillState } from "./model.js";
const execute = promisify(execFile);
export class GitHub {
  readonly origin: string;
  private token: string | undefined;
  private readonly metadataCache = new Map<string, Promise<Metadata>>();
  private readonly archiveCache = new Map<string, Promise<Buffer>>();
  constructor(readonly signal: AbortSignal) {
    const url = new URL(
      process.env.YOHO_SKILL_GITHUB_API ?? "https://api.github.com",
    );
    if (
      url.origin !== "https://api.github.com" &&
      (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        !["http:", "https:"].includes(url.protocol))
    )
      throw failure("INVALID_ARGUMENT", "GitHub 测试地址仅允许本机服务", 2);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw failure("INVALID_ARGUMENT", "GitHub 地址必须是无凭据的 origin", 2);
    this.origin = url.origin;
  }
  private async fetch(path: string, token?: string): Promise<Response> {
    return fetch(this.origin + path, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(15000)]),
      redirect: "manual",
    });
  }
  async response(path: string): Promise<Response> {
    let response = await this.fetch(path, this.token);
    if ([401, 403, 404].includes(response.status) && !this.token) {
      try {
        const result = await execute(
          "gh",
          ["auth", "token", "--hostname", "github.com"],
          { maxBuffer: 16384, signal: this.signal, timeout: 10000 },
        );
        this.token = result.stdout.trim() || undefined;
      } catch {}
      if (this.token) response = await this.fetch(path, this.token);
    }
    if (!response.ok && ![301, 302, 303, 307, 308].includes(response.status))
      throw failure(
        response.status === 401 ||
          response.status === 403 ||
          response.status === 404
          ? "SOURCE_UNAUTHORIZED"
          : "SOURCE_UNAVAILABLE",
        `GitHub 来源不可访问 (${response.status})；私有仓库请检查 gh auth login 与访问权限`,
        [401, 403, 404].includes(response.status) ? 4 : 5,
      );
    return response;
  }
  async json(path: string): Promise<unknown> {
    const response = await this.response(path);
    if (!response.ok)
      throw failure("SOURCE_PROTOCOL_ERROR", "GitHub 元数据返回了重定向", 5);
    return response.json();
  }
  async metadata(repo: string): Promise<Metadata> {
    let result = this.metadataCache.get(repo);
    if (!result) {
      result = this.readMetadata(repo);
      this.metadataCache.set(repo, result);
    }
    return result;
  }
  private async readMetadata(repo: string): Promise<Metadata> {
    const { default_branch: branch } = z
      .object({ default_branch: z.string().min(1) })
      .parse(await this.json(`/repos/${repo}`));
    const { sha: commit } = z
      .object({ sha: metadataSchema.shape.commit })
      .parse(
        await this.json(`/repos/${repo}/commits/${encodeURIComponent(branch)}`),
      );
    const content = z
      .object({ encoding: z.literal("base64"), content: z.string() })
      .parse(await this.json(`/repos/${repo}/contents/SKILL.md?ref=${commit}`));
    return { ...parseSkill(Buffer.from(content.content, "base64")), commit };
  }
  async archive(repo: string, commit: string): Promise<Buffer> {
    const key = `${repo}@${commit}`;
    let result = this.archiveCache.get(key);
    if (!result) {
      result = this.readArchive(repo, commit);
      this.archiveCache.set(key, result);
    }
    return result;
  }
  private async readArchive(repo: string, commit: string): Promise<Buffer> {
    let response = await this.response(`/repos/${repo}/tarball/${commit}`);
    if (!response.ok) {
      const location = response.headers.get("location");
      if (!location)
        throw failure("SOURCE_PROTOCOL_ERROR", "下载缺少跳转地址", 5);
      const url = new URL(location, this.origin);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "codeload.github.com" ||
        url.username ||
        url.password
      )
        throw failure("SOURCE_PROTOCOL_ERROR", "拒绝非 GitHub 下载跳转", 5);
      response = await fetch(url, {
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(30000)]),
        redirect: "error",
      });
    }
    if (!response.ok)
      throw failure("SOURCE_UNAVAILABLE", `下载失败 (${response.status})`, 5);
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (!response.body)
      throw failure("SOURCE_PROTOCOL_ERROR", "下载内容为空", 5);
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        await response.body.cancel().catch(() => {});
        throw failure("SKILL_TOO_LARGE", "Skill 压缩包超过 32 MiB", 3);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
export function parseSkill(input: string | Uint8Array) {
  let text: string;
  try {
    text =
      typeof input === "string"
        ? input
        : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw failure("SKILL_INVALID", "SKILL.md 必须使用有效的 UTF-8 编码");
  }
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match?.[1]) throw failure("SKILL_INVALID", "Skill 缺少有效 frontmatter");
  try {
    const document = metadataSchema
      .omit({ commit: true })
      .extend({
        metadata: z
          .object({ version: metadataSchema.shape.version })
          .optional(),
      })
      .parse(parse(match[1]));
    const version = document.version ?? document.metadata?.version;
    return {
      name: document.name,
      description: document.description,
      ...(version ? { version } : {}),
    };
  } catch {
    throw failure("SKILL_INVALID", "Skill name、description 或 version 无效");
  }
}
export async function refresh(
  state: SkillState,
  github: GitHub,
): Promise<CatalogItem[]> {
  const items: CatalogItem[] = [];
  for (const source of state.sources) {
    github.signal.throwIfAborted();
    try {
      source.metadata = await github.metadata(source.repo);
      items.push({
        repo: source.repo,
        ...source.metadata,
        status: "available",
      });
    } catch (error) {
      if (github.signal.aborted) throw error;
      items.push({
        repo: source.repo,
        ...source.metadata,
        status: "unavailable",
        message: error instanceof Error ? error.message : "来源不可用",
      });
    }
  }
  await saveState(state);
  return items;
}
export function sourceItem(source: Source, status: "registered"): CatalogItem {
  return { repo: source.repo, ...source.metadata, status };
}

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, lstat, writeFile, readFile, access } from "node:fs/promises";
import { devNull, homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseSkill } from "./manifest.js";
import { configDirectory } from "../core/paths.js";
import { saveState } from "./state.js";
import {
  metadataSchema,
  repository,
  failure,
  type Metadata,
  type Source,
  type CatalogItem,
  type SkillState,
} from "./model.js";

const hostKey =
  "codeup.aliyun.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQD6WbValczSDKC4ktjRzDNC1qINDAViw/oGA8ud7qH5F9XFZ4QAWhZmFBsp+cppBIOM63exjc4O9vbzMrd7AUItXigymGfTqrGt5VykIiaNhjttxSwbZf3N9eDcAvX4gGm3fcm6D1ACvPxvxMsCwOpdz5tDHqDxGOLPAXN+FSAvjdcN4uMz0MXghGh9Q3zSpy8z1TLkAKT2QBnr4q2tsdZKwWON8bBHIPwP3RSAdSUL6bAyotyncMDAvG53kwRKJ3wJ5ZezXqZNNV7EzHds+pvwThtuWtWsBuuRpL/oZiviWlXy6hILoWbkRfgONPwT0faaOn1GLzjHLuqHHfALGOen\n";

async function directory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink())
    throw failure("SKILL_CACHE_INVALID", `Codeup 缓存不是实际目录：${path}`, 5);
}
const quoted = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

export class Codeup {
  private readonly metadataCache = new Map<string, Promise<Metadata>>();
  private readonly archiveCache = new Map<string, Promise<Buffer>>();
  private readonly repositories = new Map<string, Promise<string>>();
  private environment?: Promise<NodeJS.ProcessEnv>;
  constructor(readonly signal: AbortSignal) {}

  private env(): Promise<NodeJS.ProcessEnv> {
    return (this.environment ??= (async () => {
      const root = join(configDirectory(), "codeup-cache");
      await directory(root);
      const hosts = join(root, "known-hosts");
      await writeFile(hosts, hostKey, { mode: 0o600, flag: "wx" }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
      if (
        (await lstat(hosts)).isSymbolicLink() ||
        (await readFile(hosts, "utf8")) !== hostKey
      )
        throw failure(
          "SKILL_CACHE_INVALID",
          "Codeup 缓存中的 SSH 主机密钥无效",
          5,
        );
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env))
        if (
          /^(GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG.*)|GH_TOKEN|GITHUB_TOKEN)$/.test(
            key,
          )
        )
          delete env[key];
      env.GIT_CONFIG_NOSYSTEM = "1";
      env.GIT_CONFIG_GLOBAL = devNull;
      env.GIT_TERMINAL_PROMPT = "0";
      env.GIT_SSH_VARIANT = "ssh";
      if (!env.GIT_SSH_COMMAND) {
        let key = process.env.YOHO_SKILL_SSH_KEY;
        if (key) {
          key = resolve(key);
          try {
            await access(key);
          } catch {
            throw failure("SKILL_SSH_KEY_INVALID", `SSH 私钥不可读：${key}`, 2);
          }
        } else {
          const local = join(homedir(), ".ssh/github_codeup_sync_ed25519");
          if (
            await access(local).then(
              () => true,
              () => false,
            )
          )
            key = local;
        }
        env.GIT_SSH_COMMAND = [
          "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10",
          `-o ${quoted(`UserKnownHostsFile="${hosts.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)}`,
          ...(key ? [`-i ${quoted(key)} -o IdentitiesOnly=yes`] : []),
        ].join(" ");
      }
      return env;
    })());
  }

  private async git(
    args: string[],
    limit = 1024 * 1024,
    input?: string,
  ): Promise<Buffer> {
    this.signal.throwIfAborted();
    const env = {
      ...(await this.env()),
      GIT_NO_LAZY_FETCH: args.includes("cat-file") ? "1" : "0",
    };
    return new Promise((resolve, reject) => {
      const child = spawn(
        "git",
        [
          "-c",
          "protocol.version=2",
          "-c",
          `core.hooksPath=${devNull}`,
          ...args,
        ],
        {
          env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        },
      );
      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderr = "";
      let exceeded = false;
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (signal: NodeJS.Signals) => {
        if (child.pid)
          try {
            if (process.platform !== "win32") process.kill(-child.pid, signal);
            else child.kill(signal);
          } catch {}
      };
      const stop = () => {
        kill("SIGTERM");
        killTimer ??= setTimeout(() => kill("SIGKILL"), 1000);
        killTimer.unref();
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        stop();
      }, 30000);
      child.stdin.on("error", () => {});
      child.stdin.end(input);
      this.signal.addEventListener("abort", stop, { once: true });
      if (this.signal.aborted) stop();
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > limit) {
          exceeded = true;
          stop();
        } else chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < 16384) stderr += chunk.toString();
      });
      const cleanup = () => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        this.signal.removeEventListener("abort", stop);
      };
      child.once("error", (error: NodeJS.ErrnoException) => {
        cleanup();
        reject(
          failure(
            error.code === "ENOENT" ? "GIT_REQUIRED" : "SOURCE_UNAVAILABLE",
            error.code === "ENOENT"
              ? "读取 Codeup 需要安装 Git 和 OpenSSH"
              : "无法启动 Git 读取 Codeup",
            5,
          ),
        );
      });
      child.once("close", (code) => {
        cleanup();
        if (this.signal.aborted) return reject(this.signal.reason);
        if (exceeded)
          return reject(
            failure("SKILL_TOO_LARGE", "Codeup 内容超过允许大小", 3),
          );
        if (code === 0) return resolve(Buffer.concat(chunks));
        if (timedOut)
          return reject(
            failure(
              "SOURCE_UNAVAILABLE",
              "Codeup Git 读取超时；请检查网络后重试",
              5,
            ),
          );
        const denied =
          /permission denied|authentication failed|access denied|not authorized|repository.*not found/i.test(
            stderr,
          );
        reject(
          failure(
            denied ? "SOURCE_UNAUTHORIZED" : "SOURCE_UNAVAILABLE",
            denied
              ? "Codeup SSH 访问失败；请检查仓库权限和 SSH 公钥，可用 YOHO_SKILL_SSH_KEY 指定私钥"
              : "Codeup Git 读取失败；请检查网络、Git/SSH 配置和来源地址",
            denied ? 4 : 5,
          ),
        );
      });
    });
  }

  private cached(repo: string): Promise<string> {
    let pending = this.repositories.get(repo);
    if (!pending) {
      pending = (async () => {
        const path = join(
          configDirectory(),
          "codeup-cache",
          createHash("sha256").update(repo).digest("hex"),
        );
        await this.env();
        await directory(path);
        await this.git(["init", "--bare", "--template=", path]);
        for (const [key, value] of [
          [
            "remote.origin.url",
            `git@codeup.aliyun.com:${repository(repo)}.git`,
          ],
          ["remote.origin.promisor", "true"],
          ["remote.origin.partialclonefilter", "blob:none"],
        ])
          await this.git(["-C", path, "config", key!, value!]);
        return path;
      })();
      this.repositories.set(repo, pending);
    }
    return pending;
  }

  async metadata(repo: string): Promise<Metadata> {
    let pending = this.metadataCache.get(repo);
    if (!pending) {
      pending = this.readMetadata(repo);
      this.metadataCache.set(repo, pending);
    }
    return pending;
  }

  private async readMetadata(repo: string): Promise<Metadata> {
    let commit: string | undefined;
    // Codeup sometimes omits HEAD. A sole advertised branch is unambiguous; never guess among several.
    for (let attempt = 0; attempt < 3 && !commit; attempt++) {
      const refs = (
        await this.git([
          "ls-remote",
          "--symref",
          `git@codeup.aliyun.com:${repository(repo)}.git`,
        ])
      ).toString();
      const lines = refs.split("\n").map((line) => line.split(/\s+/));
      const branches = lines.filter(
        (parts) =>
          parts[1]?.startsWith("refs/heads/") &&
          metadataSchema.shape.commit.safeParse(parts[0]).success,
      );
      const symbolic = lines.find(
        (parts) => parts[0] === "ref:" && parts[2] === "HEAD",
      )?.[1];
      const raw =
        lines.find(
          (parts) => parts[1] === "HEAD" && parts[0] !== "ref:",
        )?.[0] ??
        branches.find((parts) => parts[1] === symbolic)?.[0] ??
        (branches.length === 1 ? branches[0]?.[0] : undefined);
      const parsed = metadataSchema.shape.commit.safeParse(raw);
      if (parsed.success) commit = parsed.data;
    }
    if (!commit)
      throw failure(
        "SOURCE_PROTOCOL_ERROR",
        `Codeup 来源缺少有效的默认分支提交：${repo}`,
        5,
      );
    const path = await this.cached(repo);
    const present = await this.git([
      "-C",
      path,
      "cat-file",
      "-e",
      `${commit}^{commit}`,
    ]).then(
      () => true,
      () => false,
    );
    this.signal.throwIfAborted();
    if (!present)
      await this.git([
        "-C",
        path,
        "fetch",
        "--quiet",
        "--depth=1",
        "--filter=blob:none",
        "--no-tags",
        "origin",
        commit,
      ]);
    const entry = (
      await this.git(["-C", path, "ls-tree", commit, "--", "SKILL.md"])
    ).toString();
    if (!/^100(?:644|755) blob /.test(entry))
      throw failure(
        "SKILL_INVALID",
        `Codeup 来源缺少有效的根 SKILL.md：${repo}`,
        3,
      );
    const content = await this.git([
      "-C",
      path,
      "show",
      "--no-ext-diff",
      "--no-textconv",
      `${commit}:SKILL.md`,
    ]);
    return { ...parseSkill(content), commit };
  }

  async archive(repo: string, commit: string): Promise<Buffer> {
    const key = `${repo}@${metadataSchema.shape.commit.parse(commit)}`;
    let pending = this.archiveCache.get(key);
    if (!pending) {
      pending = this.cached(repo).then(async (path) => {
        // Fetch missing resource blobs together instead of one SSH session per file.
        const missing = (
          await this.git([
            "-C",
            path,
            "rev-list",
            "--objects",
            "--missing=print",
            "--no-object-names",
            commit,
          ])
        )
          .toString()
          .split("\n")
          .filter((line) => /^\?[a-f0-9]{40,64}$/.test(line))
          .map((line) => line.slice(1));
        if (missing.length)
          await this.git(
            [
              "-C",
              path,
              "fetch",
              "--quiet",
              "--no-tags",
              "--no-write-fetch-head",
              "--recurse-submodules=no",
              "--filter=blob:none",
              "origin",
              "--stdin",
            ],
            1024 * 1024,
            missing.join("\n") + "\n",
          );
        return this.git(
          [
            "-C",
            path,
            "archive",
            "--worktree-attributes",
            "--format=tar.gz",
            "--prefix=repository/",
            commit,
          ],
          32 * 1024 * 1024,
        );
      });
      this.archiveCache.set(key, pending);
    }
    return pending;
  }
}

export async function refresh(
  state: SkillState,
  codeup: Codeup,
): Promise<CatalogItem[]> {
  const items: CatalogItem[] = [];
  for (let start = 0; start < state.sources.length; start += 4) {
    items.push(
      ...(await Promise.all(
        state.sources
          .slice(start, start + 4)
          .map(async (source): Promise<CatalogItem> => {
            codeup.signal.throwIfAborted();
            try {
              if (source.legacyGithub)
                throw failure(
                  "SOURCE_MIGRATION_REQUIRED",
                  "此旧 GitHub 来源没有已确认的 Codeup 映射；请登记对应 Codeup 来源并移除此旧来源",
                  2,
                );
              source.metadata = await codeup.metadata(source.repo);
              return {
                repo: source.repo,
                ...source.metadata,
                status: "available",
              };
            } catch (error) {
              if (codeup.signal.aborted) throw error;
              return {
                repo: source.repo,
                ...source.metadata,
                status: "unavailable",
                message: error instanceof Error ? error.message : "来源不可用",
              };
            }
          }),
      )),
    );
  }
  await saveState(state);
  return items;
}
export function sourceItem(source: Source, status: "registered"): CatalogItem {
  return { repo: source.repo, ...source.metadata, status };
}

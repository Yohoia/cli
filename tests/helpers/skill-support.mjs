import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runCli, installedCli } from "./support.mjs";
const execute = promisify(execFile);
export async function skillFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "yoho-skills-")));
  const project = join(root, "项目 with spaces");
  const home = join(root, "home");
  await mkdir(project);
  await mkdir(home);
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const realGit = (await execute("which", ["git"])).stdout.trim();
  const helper = resolve("tests/helpers/codeup-git.mjs");
  const quote = (value) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(helper)} git "$@"\n`,
    { mode: 0o755 },
  );
  const repos = new Map();
  const requests = [];
  async function repo(id, name, extra = {}) {
    const files = {
      "SKILL.md": `---\nname: ${name}\ndescription: Test ${name}\n---\n\n# ${name}\n`,
      "references/example.md": "Reference one\n",
      "scripts/example.sh": "echo SHOULD_NOT_RUN\n",
      ...extra,
    };
    const previous = repos.get(id);
    const path = previous?.path ?? (await mkdtemp(join(root, "repository-")));
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      GIT_INDEX_FILE: join(path, "fixture-index"),
    };
    const git = (args, input, encoding = "utf8") =>
      new Promise((done, reject) => {
        const child = execFile(
          realGit,
          ["--git-dir", path, ...args],
          { env: gitEnv, encoding, maxBuffer: 4_000_000 },
          (error, stdout) => (error ? reject(error) : done(stdout)),
        );
        child.stdin.end(input);
      });
    if (!previous) {
      await execute(realGit, ["init", "--bare", "--template=", path], {
        env: gitEnv,
      });
      await git(["config", "uploadpack.allowFilter", "true"]);
      await git(["config", "uploadpack.allowAnySHA1InWant", "true"]);
    }
    await git(["read-tree", "--empty"]);
    for (const [name, value] of Object.entries(files)) {
      if (name.split("/").includes(".git")) continue;
      const descriptor =
        typeof value === "object" && !Buffer.isBuffer(value)
          ? value
          : { bytes: value, mode: "100644" };
      const { bytes, mode } = descriptor;
      const blob = (await git(["hash-object", "-w", "--stdin"], bytes)).trim();
      await git(["update-index", "--add", "--cacheinfo", mode, blob, name]);
    }
    const tree = (await git(["write-tree"])).trim();
    const commit = (
      await git(
        ["commit-tree", tree, ...(previous ? ["-p", previous.sha] : [])],
        "Fixture commit\n",
      )
    ).trim();
    const item = previous ?? {
      name,
      branch: "develop",
      versions: new Map(),
      status: 200,
      private: false,
      path,
    };
    await git(["update-ref", `refs/heads/${item.branch}`, commit]);
    await git(["symbolic-ref", "HEAD", `refs/heads/${item.branch}`]);
    const archive = await git(
      [
        "archive",
        "--worktree-attributes",
        "--format=tar.gz",
        "--prefix=repository/",
        commit,
      ],
      undefined,
      "buffer",
    );
    item.versions.set(commit, {
      files,
      archive,
      originalArchive: archive,
      originalManifest: Buffer.from(files["SKILL.md"]),
    });
    item.sha = commit;
    repos.set(id, item);
    return item;
  }
  await repo(
    "69aa892db28d0aba0f5ed47e/yoho-standard-readme",
    "yoho-standard-readme",
  );
  await repo("69aa892db28d0aba0f5ed47e/yoho-retro-poster", "yoho-retro-poster");
  await repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit");
  const active = new Set();
  async function serve(req, res) {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    const url = new URL(req.url, "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const kind = parts.shift();
    const commit = kind === "transport" ? undefined : parts.pop();
    const id = parts.join("/");
    const r = repos.get(id);
    if (r) res.once("finish", () => r.onResponse?.(res.statusCode));
    if (r?.delay) await new Promise((done) => setTimeout(done, r.delay));
    if (res.destroyed) return;
    if (
      !r ||
      r.status !== 200 ||
      (r.private && req.headers.authorization !== "Bearer fixture-ssh-identity")
    ) {
      res.writeHead(r?.status !== 200 && r?.status ? r.status : 404);
      res.end("{}");
      return;
    }
    let body = {};
    if (kind === "transport") {
      await execute(realGit, [
        "--git-dir",
        r.path,
        "update-ref",
        `refs/heads/${r.branch}`,
        r.sha,
      ]);
      if (r.extraBranch)
        await execute(realGit, [
          "--git-dir",
          r.path,
          "update-ref",
          "refs/heads/extra",
          r.sha,
        ]);
      await execute(realGit, [
        "--git-dir",
        r.path,
        "symbolic-ref",
        "HEAD",
        r.emptyHeads-- > 0 ? "refs/heads/unborn" : `refs/heads/${r.branch}`,
      ]);
      body = { path: r.path };
    } else {
      const version = r.versions.get(commit);
      if (!version) {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      if (
        kind === "metadata" &&
        !Buffer.from(version.files["SKILL.md"]).equals(version.originalManifest)
      )
        body = {
          override: Buffer.from(version.files["SKILL.md"]).toString("base64"),
        };
      if (kind === "archive") {
        if (!version.archive.equals(version.originalArchive))
          body = { override: version.archive.toString("base64") };
        r.onArchive?.();
      }
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  }
  const server = createServer((req, res) => {
    const pending = serve(req, res);
    active.add(pending);
    pending
      .catch(() => {
        res.writeHead(500);
        res.end("{}");
      })
      .finally(() => active.delete(pending));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await Promise.allSettled([...active]);
    await rm(root, { recursive: true, force: true });
  });
  const options = {
    cwd: project,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      YOHO_CONFIG_DIR: join(root, "config"),
      GH_CONFIG_DIR: join(root, "gh"),
      YOHO_TEST_CODEUP: `http://127.0.0.1:${server.address().port}`,
      YOHO_TEST_REAL_GIT: realGit,
      GIT_SSH_COMMAND: `${quote(process.execPath)} ${quote(helper)} ssh`,
      YOHO_TEST_SSH_AUTH: "",
      YOHO_SKILL_SSH_KEY: "",
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
    },
  };
  async function command(args, code = 0) {
    const out = await runCli(["skill", ...args, "--json"], options);
    if (out.code !== code)
      throw new Error(
        `Expected ${code}, got ${out.code}: ${out.stdout} ${out.stderr}`,
      );
    return JSON.parse(out.stdout);
  }
  async function terminal(
    args,
    steps,
    size = { columns: 100, rows: 30 },
    json = true,
  ) {
    const { stdout } = await execute(
      "python3",
      [
        resolve("tests/helpers/skill-pty.py"),
        JSON.stringify([
          process.execPath,
          await installedCli(),
          "skill",
          ...args,
          ...(json ? ["--json"] : []),
        ]),
        JSON.stringify(steps),
        JSON.stringify({ ...size, full: !json }),
      ],
      {
        cwd: project,
        env: { ...process.env, ...options.env, TERM: "xterm-256color" },
        maxBuffer: 4000000,
      },
    );
    return JSON.parse(stdout);
  }
  return {
    root,
    home,
    project,
    repos,
    repo,
    requests,
    options,
    command,
    terminal,
  };
}

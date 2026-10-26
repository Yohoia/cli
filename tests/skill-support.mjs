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
  const repos = new Map();
  const requests = [];
  async function repo(id, name, extra = {}) {
    const files = {
      "SKILL.md": `---\nname: ${name}\ndescription: Test ${name}\n---\n\n# ${name}\n`,
      "references/example.md": "Reference one\n",
      "scripts/example.sh": "echo SHOULD_NOT_RUN\n",
      ...extra,
    };
    const sha = (repos.get(id)?.versions.size ?? 0) + 1;
    const commit = String(sha).padStart(40, "a");
    const dir = await mkdtemp(join(root, "archive-"));
    const content = join(dir, "repository");
    await mkdir(content);
    for (const [path, bytes] of Object.entries(files)) {
      await mkdir(join(content, path, ".."), { recursive: true });
      await writeFile(join(content, path), bytes);
    }
    const archive = join(dir, "source.tgz");
    await execute("tar", ["-czf", archive, "-C", dir, "repository"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const item = repos.get(id) ?? {
      name,
      branch: "develop",
      versions: new Map(),
      status: 200,
      private: false,
    };
    item.versions.set(commit, { files, archive: await readFile(archive) });
    item.sha = commit;
    repos.set(id, item);
    return item;
  }
  await repo("yohoia/yoho-standard-readme", "yoho-standard-readme");
  await repo("yohoia/yoho-retro-poster", "yoho-retro-poster");
  await repo("yohoia/yoho-speckit", "speckit");
  const server = createServer(async (req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    const url = new URL(req.url, "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    const id = `${parts[1]}/${parts[2]}`;
    const r = repos.get(id);
    if (r) res.once("finish", () => r.onResponse?.(res.statusCode));
    if (r?.delay) await new Promise((done) => setTimeout(done, r.delay));
    if (!r) {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    if (
      r.status !== 200 ||
      (r.private &&
        req.headers.authorization !== "Bearer fixture-private-token")
    ) {
      res.writeHead(r.status !== 200 ? r.status : 404);
      res.end("{}");
      return;
    }
    let body;
    if (parts.length === 3) body = { default_branch: r.branch };
    else if (parts[3] === "commits") body = { sha: r.sha };
    else if (parts[3] === "contents") {
      const v = r.versions.get(url.searchParams.get("ref"));
      body = {
        encoding: "base64",
        content: Buffer.from(v.files["SKILL.md"]).toString("base64"),
      };
    } else if (parts[3] === "tarball") {
      const v = r.versions.get(parts[4]);
      if (!v) {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      res.end(v.archive);
      r.onArchive?.();
      return;
    } else {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
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
      YOHO_SKILL_GITHUB_API: `http://127.0.0.1:${server.address().port}`,
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
        resolve("tests/skill-pty.py"),
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

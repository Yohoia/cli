import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import { join, resolve } from "node:path";
import { access, readFile, writeFile } from "node:fs/promises";
import { installedCli, runCli } from "../helpers/support.mjs";
import { skillFixture } from "../helpers/skill-support.mjs";
import { remoteFixture } from "../helpers/remote-support.mjs";

const execute = promisify(execFile);
async function terminal(
  options,
  args,
  steps,
  size = { columns: 120, rows: 30 },
  expected = 0,
) {
  const { stdout } = await execute(
    "python3",
    [
      resolve("tests/helpers/skill-pty.py"),
      JSON.stringify([process.execPath, await installedCli(), ...args]),
      JSON.stringify(steps),
      JSON.stringify({ ...size, full: true }),
    ],
    {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, TERM: "xterm-256color" },
      maxBuffer: 4_000_000,
    },
  );
  const result = JSON.parse(stdout);
  assert.deepEqual(result.pending, [], result.terminal);
  assert.equal(result.code, expected, result.terminal);
  assert.match(result.terminal, /\x1b\[\?1049h/u);
  assert.match(result.terminal, /\x1b\[\?25h\x1b\[\?1049l/u);
  return result;
}

test("bare yoho opens the Mole-style home and restores the terminal after navigation", async (t) => {
  const f = await skillFixture(t);
  const result = await terminal(
    f.options,
    [],
    [
      { wait: "Articles and Agent Skills.", keys: "v" },
      { wait: "Node.js", keys: "q" },
      { wait: "Articles and Agent Skills.", keys: "m" },
      { wait: "Keyboard Shortcuts", keys: "q" },
      { wait: "Articles and Agent Skills.", keys: "q" },
    ],
  );
  const text = stripVTControlCharacters(result.terminal);
  for (const label of ["Blog", "Skill", "Auth", "Settings", "Space", "搜索"])
    assert.ok(text.includes(label));
  assert.equal(result.stdout, "");
});

test("the interactive Skill page installs and uninstalls through the real commands with explicit confirmation", async (t) => {
  const f = await skillFixture(t);
  await terminal(
    f.options,
    [],
    [
      { wait: "Articles and Agent Skills.", keys: "2" },
      { wait: "0/3 selected", keys: "i" },
      { wait: "安装范围", keys: "\r" },
      { wait: "安装目标", keys: "\x1b[B \r" },
      { wait: "Skill 操作结果", keys: "\r" },
      { wait: "0/3 selected", keys: "d" },
      { wait: "确认删除", keys: "\r" },
      { wait: "0/3 selected", keys: "d" },
      { wait: "确认删除", keys: "\x1b[B\r" },
      { wait: "Skill 操作结果", keys: "\r" },
      { wait: "0/3 selected", keys: "q" },
      { wait: "Articles and Agent Skills.", keys: "q" },
    ],
  );
  await assert.rejects(access(join(f.project, ".agents/skills/speckit")), {
    code: "ENOENT",
  });
  const state = JSON.parse(
    await readFile(join(f.root, "config/skills.json"), "utf8"),
  );
  assert.equal(state.records.length, 0);
  assert.equal(state.sources.length, 3);
});

test("Skill search clears hidden selections, and source management remains offline and keyboard accessible", async (t) => {
  const f = await skillFixture(t);
  const result = await terminal(
    f.options,
    ["skill"],
    [
      { wait: "0/3 selected", keys: " /" },
      { wait: "Type to search", keys: "speckit\r" },
      { wait: "0/1 selected", keys: "\r" },
      { wait: "Status:", keys: "q" },
      { wait: "0/1 selected", keys: "m" },
      { wait: "Skill Sources  ", keys: "n" },
      { wait: "Add Source", keys: "team/new-skill\r" },
      { wait: "registered  team/new-skill", keys: "\r" },
      { wait: "0/4 selected", keys: "q" },
      { wait: "0/1 selected", keys: "q" },
    ],
    { columns: 60, rows: 24 },
  );
  assert.match(stripVTControlCharacters(result.terminal), /speckit/);
  const state = JSON.parse(
    await readFile(join(f.root, "config/skills.json"), "utf8"),
  );
  assert.ok(state.sources.some((source) => source.repo === "team/new-skill"));
});

test("Blog multi-select previews revisions, cancels by default, then deletes only confirmed articles", async (t) => {
  const api = await remoteFixture(t);
  const options = api.options(await api.device());
  const articles = [];
  for (const name of ["Alpha", "Beta"]) {
    const path = join(api.root, `${name}.md`);
    await writeFile(path, `# ${name}\n\nArticle body.\n`);
    const created = await runCli(["blog", "create", path, "--json"], options);
    assert.equal(created.code, 0, created.stdout);
    articles.push(JSON.parse(created.stdout).data.article);
  }
  await terminal(
    options,
    ["blog"],
    [
      { wait: "0/2 selected", keys: " \x1b[B d" },
      { wait: "确认删除", keys: "\r" },
      { wait: "0/2 selected", keys: "ad" },
      { wait: "确认删除", keys: "\x1b[B\r" },
      { wait: "删除结果", keys: "\r" },
      { wait: "0/0 selected", keys: "q" },
    ],
  );
  for (const article of articles) {
    const show = await runCli(["blog", "show", article.id, "--json"], options);
    assert.equal(JSON.parse(show.stdout).error.code, "ARTICLE_NOT_FOUND");
  }
});

test("a nonterminal bare invocation prints help and JSON never opens the interactive shell", async (t) => {
  const f = await skillFixture(t);
  const help = await runCli([], f.options);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: yoho/);
  assert.ok(!help.stdout.includes("\x1b[?1049h"));
  const json = await runCli(["--json"], f.options);
  assert.equal(json.code, 2);
  assert.equal(JSON.parse(json.stdout).error.code, "INVALID_ARGUMENT");
});

test("Blog uploads a path containing Chinese spaces, opens the article and publishes the previewed revision", async (t) => {
  const api = await remoteFixture(t);
  const options = api.options(await api.device());
  options.env.YOHO_SERVER = "https://unused.example.test";
  const path = join(api.root, "中文 文档.md");
  const content = "# 交互创建的文章\n\n正文和摘要保持原样。\n";
  await writeFile(path, content);
  await terminal(
    options,
    ["--server", api.url, "blog"],
    [
      { wait: "0/0 selected", keys: "n" },
      { wait: "New Article", keys: `${path}\r` },
      { wait: "操作已完成", keys: "\r" },
      { wait: "0/1 selected", keys: "\r" },
      { wait: "Version:", keys: "p" },
      { wait: "确认发布", keys: "\x1b[B\r" },
      { wait: "发布结果", keys: "\r" },
      { wait: "0/1 selected", keys: "q" },
    ],
  );
  const listed = await runCli(
    ["--server", api.url, "blog", "list", "--json"],
    options,
  );
  const [article] = JSON.parse(listed.stdout).data.items;
  assert.equal(article.status, "published");
  assert.equal(article.title, "交互创建的文章");
  assert.equal(article.content, content);
  assert.equal(await readFile(path, "utf8"), content);
});

test("Ctrl+C stops an interactive child operation, drains cleanup and restores raw input", async (t) => {
  const f = await skillFixture(t);
  for (const repo of f.repos.values()) repo.delay = 1000;
  const result = await terminal(
    f.options,
    ["skill"],
    [{ wait: "Skills · 正在读取", keys: "\u0003" }],
    { columns: 80, rows: 24 },
    130,
  );
  assert.match(stripVTControlCharacters(result.terminal), /CANCELLED/);
  await f.command(["source", "list"]);
  await assert.rejects(access(join(f.root, "config/skills.lock")), {
    code: "ENOENT",
  });
});

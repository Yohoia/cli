import test from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  stat,
  utimes,
  chmod,
  symlink,
  link,
  readdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixture, article, runCli, startCli } from "./support.mjs";

test("通过调用目录中的正文输入更新 MDX，逐字保留 frontmatter 和输入文件", async (t) => {
  const project = await fixture(t);
  const source =
    "\uFEFF---\r\n# 注释\r\ntitle: 标题\r\ndescription: Example\r\npublishedAt: 2026-10-01\r\nauthor: Yoho\r\ncustom: {keep: true}\r\n---\r\n旧正文\r\n";
  const file = await project.write("nested/entry.mdx", source);
  await chmod(file, 0o640);
  const inputProject = await fixture(t);
  const input = join(inputProject.root, "body.mdx");
  const body =
    "---\r\n保持输入的 frontmatter\r\n---\r\n\r\n<Component />\n![图片](../../assets/images/pic.png)  \n结尾";
  await writeFile(input, body);
  const updated = await runCli(
    [
      "--project",
      project.root,
      "blog",
      "update",
      "nested/entry",
      "--body-file",
      "body.mdx",
      "--json",
    ],
    { cwd: inputProject.root },
  );
  assert.equal(updated.code, 0, updated.stdout);
  assert.equal(updated.stderr, "");
  const { data } = JSON.parse(updated.stdout);
  assert.equal(data.id, "nested/entry");
  assert.equal(data.title, "标题");
  assert.equal(data.changed, true);
  assert.equal(
    await readFile(file, "utf8"),
    source.replace("旧正文\r\n", body),
  );
  assert.equal(await readFile(input, "utf8"), body);
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  const shown = await runCli(["blog", "show", "nested/entry", "--json"], {
    cwd: project.root,
  });
  assert.equal(JSON.parse(shown.stdout).data.content, body);
  assert.equal(JSON.parse(shown.stdout).data.revision, data.revision);
});

test("组合修改与清空正文作为一次更新，规范化后相同内容不写入", async (t) => {
  const project = await fixture(t);
  const body = "\n![图片](./image.png)\r\n末尾  ";
  const source = article({ body });
  const file = await project.write("entry.md", source);
  const input = join(project.root, "body.txt");
  await writeFile(input, body);
  await utimes(file, 1_000_000, 1_000_000);
  const before = await stat(file, { bigint: true });
  const same = await runCli(
    [
      "blog",
      "update",
      "entry",
      "--title",
      " 原始标题 ",
      "--body-file",
      input,
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(same.code, 0, same.stdout);
  assert.equal(JSON.parse(same.stdout).data.changed, false);
  assert.equal((await stat(file, { bigint: true })).mtimeNs, before.mtimeNs);
  assert.equal((await stat(file, { bigint: true })).ino, before.ino);
  await writeFile(input, "");
  const updated = await runCli(
    [
      "blog",
      "update",
      "entry",
      "--title",
      " 新标题 ",
      "--body-file",
      input,
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(updated.code, 0, updated.stdout);
  assert.equal(JSON.parse(updated.stdout).data.title, "新标题");
  assert.equal(
    await readFile(file, "utf8"),
    source.replace("title: 原始标题", 'title: "新标题"').slice(0, -body.length),
  );
  const sameText = await runCli(
    ["blog", "update", "entry", "--body-file", input],
    { cwd: project.root },
  );
  assert.equal(sameText.code, 0, sameText.stderr);
  assert.match(sameText.stdout, /未修改 entry/);
});

test("无变更参数、无效输入与同一实际文件都保留整篇文章", async (t) => {
  const project = await fixture(t);
  const source = article();
  const file = await project.write("entry.md", source);
  const invalid = join(project.root, "invalid.txt");
  await writeFile(invalid, Buffer.from([0xff, 0xfe]));
  const symbolic = join(project.root, "symbolic.txt");
  await symlink(file, symbolic);
  const hard = join(project.root, "hard.txt");
  await link(file, hard);
  for (const [flags, code, error] of [
    [[], 2, "INVALID_ARGUMENT"],
    [["--if-match", "unused"], 2, "INVALID_ARGUMENT"],
    [["--title", "新标题", "--body-file", invalid], 2, "INVALID_ARGUMENT"],
    [["--title", "新标题", "--body-file", project.root], 2, "INVALID_ARGUMENT"],
    [
      ["--title", "新标题", "--body-file", join(project.root, "missing")],
      5,
      "IO_ERROR",
    ],
    [["--title", "新标题", "--body-file", file], 2, "INVALID_ARGUMENT"],
    [["--body-file", symbolic], 2, "INVALID_ARGUMENT"],
    [["--body-file", hard], 2, "INVALID_ARGUMENT"],
  ]) {
    const result = await runCli(
      ["blog", "update", "entry", ...flags, "--json"],
      { cwd: project.root },
    );
    assert.equal(result.code, code, result.stdout);
    assert.equal(JSON.parse(result.stdout).error.code, error);
    assert.equal(result.stderr, "");
    assert.equal(await readFile(file, "utf8"), source);
  }
});

test("正文版本检查覆盖无变化和独立进程并发写入", async (t) => {
  const project = await fixture(t);
  const file = await project.write("entry.md", article());
  const before = await runCli(["blog", "show", "entry", "--json"], {
    cwd: project.root,
  });
  const revision = JSON.parse(before.stdout).data.revision;
  const inputs = [
    join(project.root, "first.txt"),
    join(project.root, "second.txt"),
  ];
  await Promise.all(
    inputs.map((path, index) => writeFile(path, `不同正文 ${index}\n`)),
  );
  const results = await Promise.all(
    inputs.map((input) =>
      runCli(
        [
          "blog",
          "update",
          "entry",
          "--body-file",
          input,
          "--if-match",
          revision,
          "--json",
        ],
        { cwd: project.root },
      ),
    ),
  );
  assert.equal(
    results.filter((result) => result.code === 0).length,
    1,
    JSON.stringify(results),
  );
  const loser = results.find((result) => result.code !== 0);
  assert.equal(loser.code, 3, loser.stdout);
  assert.equal(JSON.parse(loser.stdout).error.code, "ARTICLE_CONFLICT");
  const current = await readFile(file, "utf8");
  const shown = await runCli(["blog", "show", "entry", "--json"], {
    cwd: project.root,
  });
  const currentBody = JSON.parse(shown.stdout).data.content;
  await writeFile(inputs[0], currentBody);
  const stale = await runCli(
    [
      "blog",
      "update",
      "entry",
      "--body-file",
      inputs[0],
      "--if-match",
      revision,
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(stale.code, 3, stale.stdout);
  assert.equal(JSON.parse(stale.stdout).error.code, "ARTICLE_CONFLICT");
  assert.equal(await readFile(file, "utf8"), current);
});

test("正文读取权限、替换 I/O 错误与提交前取消保持原文并清理暂存", async (t) => {
  const project = await fixture(t);
  const source = article();
  const file = await project.write("entry.md", source);
  const input = join(project.root, "body.txt");
  await writeFile(input, "新正文\n");
  await chmod(input, 0o000);
  try {
    const denied = await runCli(
      [
        "blog",
        "update",
        "entry",
        "--title",
        "新标题",
        "--body-file",
        input,
        "--json",
      ],
      { cwd: project.root },
    );
    assert.equal(denied.code, 4, denied.stdout);
    assert.equal(JSON.parse(denied.stdout).error.code, "PERMISSION_DENIED");
    assert.equal(await readFile(file, "utf8"), source);
  } finally {
    await chmod(input, 0o600);
  }
  const preload = join(project.root, "fault.cjs");
  await writeFile(
    preload,
    `const fs = require('node:fs/promises'); const delay = require('node:timers/promises').setTimeout; const original = fs.open; fs.open = async (...args) => {const file = await original(...args); if (String(args[0]).endsWith('.tmp')) {const write = file.writeFile.bind(file); file.writeFile = async (data, options) => {await write(data, options); process.stderr.write('test: temporary pending\\n'); await delay(5000, undefined, {signal: options.signal});};} return file;};`,
  );
  const { child, result } = await startCli(
    [
      "blog",
      "update",
      "entry",
      "--title",
      "新标题",
      "--body-file",
      input,
      "--json",
    ],
    { cwd: project.root, env: { NODE_OPTIONS: `--require=${preload}` } },
  );
  child.stderr.on("data", (chunk) => {
    if (chunk.includes("test: temporary pending")) child.kill("SIGINT");
  });
  const cancelled = await result;
  assert.equal(cancelled.code, 130, JSON.stringify(cancelled));
  assert.equal(JSON.parse(cancelled.stdout).error.code, "CANCELLED");
  assert.equal(await readFile(file, "utf8"), source);
  assert.deepEqual(await readdir(project.content), ["entry.md"]);
  await writeFile(
    preload,
    `const fs = require('node:fs/promises'); fs.rename = async () => {throw Object.assign(new Error('disk I/O failure'),{code:'EIO'});};`,
  );
  const failed = await runCli(
    ["blog", "update", "entry", "--body-file", input, "--json"],
    { cwd: project.root, env: { NODE_OPTIONS: `--require=${preload}` } },
  );
  assert.equal(failed.code, 5, failed.stdout);
  assert.equal(JSON.parse(failed.stdout).error.code, "IO_ERROR");
  assert.equal(await readFile(file, "utf8"), source);
  assert.deepEqual(await readdir(project.content), ["entry.md"]);
});

test("正文更新可由博客实际内容加载器读取，破损旁文不阻断目标", async (t) => {
  const project = await fixture(t);
  const file = await project.write("entry.md", article());
  await project.write("broken.md", "---\ntitle: [\n---\n");
  const input = join(project.root, "-");
  const body = "\n![图片](../../assets/images/cover.png)\n新内容。";
  await writeFile(input, body);
  const updated = await runCli(
    ["blog", "update", "entry", "--title", "兼容标题", "--body-file", "-"],
    { cwd: project.root },
  );
  assert.equal(updated.code, 0, updated.stderr);
  assert.match(updated.stdout, /已修改 entry/);
  const blogRoot = resolve(process.env.YOHO_BLOG_PROJECT ?? "../yoho-blog");
  const loader = pathToFileURL(join(blogRoot, "src/lib/content.ts")).href;
  const script = `import {readFile} from 'node:fs/promises'; const {parsePublishedBlogSources} = await import(process.argv[1]); process.stdout.write(JSON.stringify(parsePublishedBlogSources([{id:'entry',source:await readFile(process.argv[2],'utf8')}])));`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script, loader, file],
    { cwd: blogRoot, env: { ...process.env, BLOG_CONTENT_SOURCE: "local" } },
  );
  const [entry] = JSON.parse(stdout);
  assert.equal(entry.data.title, "兼容标题");
  assert.match(entry.body, /新内容/);
  assert.equal(await readFile(input, "utf8"), body);
});

test("frontmatter 结束分隔符位于文件末尾时仍可加入正文", async (t) => {
  const project = await fixture(t);
  const source =
    "---\ntitle: 原始标题\ndescription: Example\npublishedAt: 2026-10-01\n---";
  const file = await project.write("entry.md", source);
  const input = join(project.root, "body.txt");
  await writeFile(input, "正文无结尾换行");
  const updated = await runCli(
    ["blog", "update", "entry", "--body-file", input, "--json"],
    { cwd: project.root },
  );
  assert.equal(updated.code, 0, updated.stdout);
  assert.equal(await readFile(file, "utf8"), source + "\n正文无结尾换行");
});

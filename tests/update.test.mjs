import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, chmod, writeFile, utimes, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixture, runCli, article } from "./support.mjs";

test("仅修改标题，保留 CRLF、BOM、注释、未知字段、日期和正文", async t => {
  const project = await fixture(t);
  const source = '\uFEFF---\r\n# 原有注释\r\ntitle: "原始标题" # 标题注释\r\ndescription: Example\r\nstatus: published\r\npublishedAt: 2026-10-01\r\nupdatedAt: 2026-10-02\r\nauthor: Yoho\r\ncustom: {keep: true}\r\nthumbnail: ../../assets/images/cover.png\r\n---\r\n\r\n# 原始标题\r\n正文。\r\n';
  const file = await project.write("knn.md", source);
  await chmod(file, 0o640);
  const result = await runCli(["blog", "update", "knn", "--title", '  中文 "新标题"  ', "--json"], { cwd: project.root });
  assert.equal(result.code, 0, result.stdout);
  const { data } = JSON.parse(result.stdout);
  assert.equal(data.id, "knn");
  assert.equal(data.title, '中文 "新标题"');
  assert.equal(data.changed, true);
  assert.equal(await readFile(file, "utf8"), source.replace('"原始标题"', '"中文 \\"新标题\\""'));
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  const shown = await runCli(["blog", "show", "knn", "--json"], { cwd: project.root });
  assert.equal(JSON.parse(shown.stdout).data.revision, data.revision);
});

test("相同标题不重写文件，参数错误保留原文件", async t => {
  const project = await fixture(t);
  const source = article();
  const file = await project.write("knn.md", source);
  await utimes(file, 1_000_000, 1_000_000);
  const before = await stat(file, { bigint: true });
  const same = await runCli(["blog", "update", "knn", "--title", "原始标题", "--json"], { cwd: project.root });
  assert.equal(same.code, 0, same.stdout);
  assert.equal(JSON.parse(same.stdout).data.changed, false);
  const after = await stat(file, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ino, before.ino);
  for (const title of ["", "  ", "一行\n二行", "一行\r二行", "一行\u2028二行"]) {
    const invalid = await runCli(["blog", "update", "knn", "--title", title, "--json"], { cwd: project.root });
    assert.equal(invalid.code, 2, invalid.stdout);
  }
  const missing = await runCli(["blog", "update", "knn", "--json"], { cwd: project.root });
  assert.equal(missing.code, 2);
  assert.equal(await readFile(file, "utf8"), source);
});

test("无条件更新读取最新文件，其他文章损坏不影响目标", async t => {
  const project = await fixture(t);
  const file = await project.write("knn.md", article());
  await project.write("broken.md", "---\ntitle: [\n---\n");
  await runCli(["blog", "show", "knn", "--json"], { cwd: project.root });
  const current = article({ body: "\n手动补充的正文\n", extra: "author: Updated Author\n" });
  await writeFile(file, current);
  const result = await runCli(["blog", "update", "knn", "--title", "新标题"], { cwd: project.root });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /已修改 knn/);
  assert.equal(await readFile(file, "utf8"), current.replace("title: 原始标题", 'title: "新标题"'));
});

test("没有目录写权限时保留原文件", async t => {
  const project = await fixture(t);
  const source = article();
  const file = await project.write("knn.md", source);
  await chmod(project.content, 0o555);
  try {
    const result = await runCli(["blog", "update", "knn", "--title", "新标题", "--json"], { cwd: project.root });
    assert.equal(result.code, 4, result.stdout);
    assert.equal(await readFile(file, "utf8"), source);
  } finally {
    await chmod(project.content, 0o755);
  }
});

test("操作系统在替换文件时返回 I/O 错误，原文保持完整且无残留临时文件", async t => {
  const project = await fixture(t);
  const source = article();
  const file = await project.write("knn.md", source);
  const preload = join(project.root, "io-failure.cjs");
  await writeFile(preload, `const fs = require('node:fs/promises'); const original = fs.rename; fs.rename = async (from, to) => { if (to === process.env.YOHO_FAULT_TARGET) throw Object.assign(new Error('simulated disk I/O error'), {code:'EIO'}); return original(from, to); };`);
  const result = await runCli(["blog", "update", "knn", "--title", "新标题", "--json"], { cwd: project.root, env: { NODE_OPTIONS: `--require=${preload}`, YOHO_FAULT_TARGET: file } });
  assert.equal(result.code, 5, result.stdout);
  assert.equal(JSON.parse(result.stdout).error.code, "IO_ERROR");
  assert.equal(await readFile(file, "utf8"), source);
  assert.deepEqual(await readdir(project.content), ["knn.md"]);
});

test("块标题保留标题注释及其余原文", async t => {
  const project = await fixture(t);
  const source = '---\r\ntitle: >- # 标题注释\r\n  原始\r\n  标题\r\ndescription: Example\r\npublishedAt: 2026-10-01\r\n---\r\n正文\r\n';
  const file = await project.write("knn.md", source);
  const result = await runCli(["blog", "update", "knn", "--title", "新标题", "--json"], { cwd: project.root });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(await readFile(file, "utf8"), '---\r\ntitle: "新标题" # 标题注释\r\ndescription: Example\r\npublishedAt: 2026-10-01\r\n---\r\n正文\r\n');
});

test("非 UTF-8 文件不能在编辑时悄悄损坏其他字节", async t => {
  const project = await fixture(t);
  const file = await project.write("knn.md", Buffer.concat([Buffer.from(article()), Buffer.from([0xff])]));
  const before = await readFile(file);
  const result = await runCli(["blog", "update", "knn", "--title", "新标题", "--json"], { cwd: project.root });
  assert.equal(result.code, 3, result.stdout);
  assert.deepEqual(await readFile(file), before);
});

test("标题共享给其他元数据时拒绝联动修改，独立别名标题可被替换", async t => {
  const project = await fixture(t);
  const shared = article().replace("title: 原始标题", "title: &title 原始标题\nsubtitle: *title");
  const file = await project.write("shared.md", shared);
  const result = await runCli(["blog", "update", "shared", "--title", "新标题", "--json"], { cwd: project.root });
  assert.equal(result.code, 3, result.stdout);
  assert.equal(await readFile(file, "utf8"), shared);
  const alias = article().replace("title: 原始标题", "baseTitle: &base 原始标题\ntitle: *base");
  const aliasFile = await project.write("alias.md", alias);
  const updated = await runCli(["blog", "update", "alias", "--title", "新标题", "--json"], { cwd: project.root });
  assert.equal(updated.code, 0, updated.stdout);
  assert.equal(await readFile(aliasFile, "utf8"), alias.replace("title: *base", 'title: "新标题"'));
});

test("修改后的临时文章可由博客实际内容加载器读取", async t => {
  const project = await fixture(t);
  const file = await project.write("knn.md", article({ extra: "author: Yoho\nthumbnail: ../../assets/images/cover.png\n" }));
  const result = await runCli(["blog", "update", "knn", "--title", "兼容性标题", "--json"], { cwd: project.root });
  assert.equal(result.code, 0, result.stdout);
  const blogRoot = resolve(process.env.YOHO_BLOG_PROJECT ?? "../yoho-blog");
  const loader = pathToFileURL(join(blogRoot, "src/lib/content.ts")).href;
  const script = `import { readFile } from 'node:fs/promises'; const { parsePublishedBlogSources } = await import(process.argv[1]); const entries = parsePublishedBlogSources([{id:'knn',source:await readFile(process.argv[2],'utf8')}]); process.stdout.write(JSON.stringify(entries));`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, loader, file], { cwd: blogRoot, env: { ...process.env, BLOG_CONTENT_SOURCE: "local" } });
  const [entry] = JSON.parse(stdout);
  assert.equal(entry.data.title, "兼容性标题");
  assert.equal(entry.data.thumbnail, "/media/cover.png");
});

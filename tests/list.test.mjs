import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, article, runCli } from "./support.mjs";

test("安装后的 CLI 可以列出真实文章并返回 JSON", async t => {
  const project = await fixture(t);
  await project.write("knn.md", article());
  const result = await runCli(["blog", "list", "--json"], { cwd: project.root });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    data: { items: [{ id: "knn", title: "原始标题", status: "published", publishedAt: "2026-10-01T00:00:00.000Z" }] },
  });
  assert.equal(result.stderr, "");
});

test("管理列表包含所有状态，筛选与日期及标识排序稳定", async t => {
  const project = await fixture(t);
  await project.write("z.mdx", article({ status: "draft", date: "2026-10-03" }));
  await project.write("nested/a.md", article({ status: "archived", date: "2026-10-03" }));
  await project.write("old.md", article({ date: "2026-09-30", extra: "draft: true\n" }));
  const all = JSON.parse((await runCli(["blog", "list", "--json"], { cwd: project.root })).stdout);
  assert.deepEqual(all.data.items.map(item => [item.id, item.status]), [["nested/a", "archived"], ["z", "draft"], ["old", "published"]]);
  const filtered = JSON.parse((await runCli(["blog", "list", "--status", "draft", "--json"], { cwd: project.root })).stdout);
  assert.deepEqual(filtered.data.items.map(item => item.id), ["z"]);
});

test("项目子目录自动定位，其他目录可显式指定项目，读取不回写默认值", async t => {
  const project = await fixture(t);
  const file = await project.write("draft.md", "---\ntitle: Draft\ndescription: Example\npublishedAt: 2026-10-01\n---\nBody\n");
  const before = await readFile(file, "utf8");
  const nested = join(project.root, "some", "nested");
  await mkdir(nested, { recursive: true });
  const implicit = await runCli(["blog", "list", "--json"], { cwd: nested });
  const explicit = await runCli(["--project", project.root, "blog", "list", "--json"], { cwd: join(project.root, "..") });
  assert.equal(implicit.code, 0);
  assert.equal(explicit.stdout, implicit.stdout);
  assert.equal(JSON.parse(explicit.stdout).data.items[0].status, "draft");
  assert.equal(await readFile(file, "utf8"), before);
  const text = await runCli(["blog", "list"], { cwd: project.root });
  assert.match(text.stdout, /draft\s+draft\s+2026-10-01\s+Draft/);
});

test("损坏文章即使被筛选排除也使列表失败，错误 JSON 只写 stdout", async t => {
  const project = await fixture(t);
  await project.write("good.md", article());
  await project.write("broken.md", "---\ntitle: [broken\n---\nBody");
  const result = await runCli(["blog", "list", "--status", "published", "--json"], { cwd: project.root });
  assert.equal(result.code, 3);
  const failure = JSON.parse(result.stdout);
  assert.equal(failure.ok, false);
  assert.equal(failure.error.code, "ARTICLE_INVALID");
  assert.match(failure.error.message, /broken.md/);
  assert.equal(result.stderr, "");
});

test("参数错误和无法定位项目均提供结构化失败", async t => {
  const project = await fixture(t);
  for (const args of [["blog", "list", "--status", "other", "--json"], ["--json", "blog", "list", "--unknown"], ["--project", join(project.root, "missing"), "blog", "list", "--json"]]) {
    const result = await runCli(args, { cwd: project.root });
    assert.equal(result.code, 2, result.stdout);
    assert.equal(JSON.parse(result.stdout).ok, false);
    assert.equal(result.stderr, "");
  }
});

test("权限错误和系统读写错误具有不同退出码", async t => {
  const project = await fixture(t);
  const file = await project.write("private.md", article());
  await chmod(file, 0);
  t.after(() => chmod(file, 0o600).catch(() => undefined));
  const denied = await runCli(["blog", "list", "--json"], { cwd: project.root });
  assert.equal(denied.code, 4, denied.stdout);
  assert.equal(JSON.parse(denied.stdout).error.code, "PERMISSION_DENIED");
  const io = await runCli(["--project", join(project.root, "x".repeat(300)), "blog", "list", "--json"], { cwd: project.root });
  assert.equal(io.code, 5, io.stdout);
  assert.equal(JSON.parse(io.stdout).error.code, "IO_ERROR");
});

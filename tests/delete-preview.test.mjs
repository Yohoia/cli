import test from "node:test";
import assert from "node:assert/strict";
import {
  lstat,
  readdir,
  readFile,
  symlink,
  writeFile,
  mkdir,
  chmod,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { fixture, article, runCli, startCli } from "./support.mjs";

async function snapshot(root) {
  const entries = [];
  async function visit(path) {
    const info = await lstat(path);
    entries.push({
      path: relative(root, path),
      mode: info.mode,
      mtime: info.mtimeMs,
      bytes: info.isFile() ? await readFile(path, "utf8") : undefined,
    });
    if (info.isDirectory()) {
      for (const name of (await readdir(path)).sort())
        await visit(join(path, name));
    }
  }
  await visit(root);
  return entries;
}

test("安装后的 CLI 预览普通及子目录文章删除，无文件内容、修改时间或目录变化", async (t) => {
  const project = await fixture(t);
  for (const name of ["first.md", "nested/second.mdx"])
    await project.write(name, article());
  await project.write("broken.md", "---\ntitle: [\n---\n");
  const before = await snapshot(project.root);
  for (const id of ["first", "nested/second"]) {
    const shown = await runCli(["blog", "show", id, "--json"], {
      cwd: project.root,
    });
    const article = JSON.parse(shown.stdout).data;
    for (const flags of [[], ["--yes"]]) {
      const preview = await runCli(
        [
          "--project",
          project.root,
          "blog",
          "delete",
          id,
          "--dry-run",
          "--json",
          ...flags,
        ],
        { cwd: project.content },
      );
      assert.equal(preview.code, 0, preview.stdout);
      assert.equal(preview.stderr, "");
      assert.deepEqual(JSON.parse(preview.stdout), {
        ok: true,
        data: {
          id,
          path: article.path,
          revision: article.revision,
          dryRun: true,
          deleted: false,
        },
      });
    }
  }
  assert.deepEqual(await snapshot(project.root), before);
  const text = await runCli(["blog", "delete", "first", "--dry-run"], {
    cwd: project.root,
  });
  assert.equal(text.code, 0, text.stdout);
  assert.match(text.stdout, /预览.*尚未删除/);
  assert.match(text.stdout, /first/);
  assert.match(text.stdout, /版本/);
});

test("预览校验文章版本，缺少删除授权时不会交互或删除", async (t) => {
  const project = await fixture(t);
  const file = await project.write("article.md", article());
  const shown = await runCli(["blog", "show", "article", "--json"], {
    cwd: project.root,
  });
  const revision = JSON.parse(shown.stdout).data.revision;
  const matching = await runCli(
    [
      "blog",
      "delete",
      "article",
      "--dry-run",
      "--if-match",
      revision,
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(matching.code, 0, matching.stdout);
  await writeFile(file, article({ title: "新的文章" }));
  const before = await snapshot(project.root);
  const stale = await runCli(
    [
      "blog",
      "delete",
      "article",
      "--dry-run",
      "--if-match",
      revision,
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(stale.code, 3, stale.stdout);
  assert.equal(JSON.parse(stale.stdout).error.code, "ARTICLE_CONFLICT");
  for (const flags of [[], ["--dry-run", "--if-match", ""]]) {
    const result = await runCli(
      ["blog", "delete", "article", "--json", ...flags],
      { cwd: project.root },
    );
    assert.equal(result.code, 2, result.stdout);
    assert.equal(JSON.parse(result.stdout).error.code, "INVALID_ARGUMENT");
    assert.equal(result.stderr, "");
  }
  assert.deepEqual(await snapshot(project.root), before);
});

test("预览独立校验目标，拒绝不存在、损坏、非普通文件和歧义文章", async (t) => {
  const project = await fixture(t);
  await project.write("bad.md", "---\ntitle: [\n---\n");
  await project.write("duplicate.md", article());
  await project.write("duplicate.mdx", article());
  await mkdir(join(project.content, "directory.md"));
  const before = await snapshot(project.root);
  for (const [id, code] of [
    ["missing", "ARTICLE_NOT_FOUND"],
    ["new/absent", "ARTICLE_NOT_FOUND"],
    ["bad", "ARTICLE_INVALID"],
    ["directory", "ARTICLE_INVALID"],
    ["duplicate", "ARTICLE_ID_AMBIGUOUS"],
  ]) {
    const result = await runCli(["blog", "delete", id, "--dry-run", "--json"], {
      cwd: project.root,
    });
    assert.equal(result.code, 3, result.stdout);
    assert.equal(JSON.parse(result.stdout).error.code, code);
    assert.equal(result.stderr, "");
  }
  assert.deepEqual(await snapshot(project.root), before);
});

test("删除预览拒绝目标和父目录中的符号链接，优先报告真实路径越界", async (t) => {
  const project = await fixture(t);
  const file = await project.write("nested/target.md", article());
  await symlink(file, join(project.content, "linked.md"));
  await symlink(
    join(project.content, "nested"),
    join(project.content, "inside"),
  );
  await symlink(
    join(project.content, "missing.md"),
    join(project.content, "dangling.md"),
  );
  const outside = join(project.root, "outside.md");
  await writeFile(outside, article());
  await symlink(outside, join(project.content, "escape.md"));
  await symlink(project.root, join(project.content, "outside"));
  const before = await snapshot(project.root);
  for (const [id, code, exit] of [
    ["linked", "ARTICLE_INVALID", 3],
    ["inside/target", "ARTICLE_INVALID", 3],
    ["inside/missing", "ARTICLE_INVALID", 3],
    ["dangling", "ARTICLE_INVALID", 3],
    ["escape", "PATH_OUTSIDE_CONTENT", 2],
    ["outside/outside", "PATH_OUTSIDE_CONTENT", 2],
    ["outside/missing", "PATH_OUTSIDE_CONTENT", 2],
  ]) {
    const result = await runCli(["blog", "delete", id, "--dry-run", "--json"], {
      cwd: project.root,
    });
    assert.equal(result.code, exit, `${id}: ${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).error.code, code);
  }
  const invalid = await runCli(
    ["blog", "delete", "../outside", "--dry-run", "--json"],
    { cwd: project.root },
  );
  assert.equal(invalid.code, 2, invalid.stdout);
  assert.deepEqual(await snapshot(project.root), before);
  const stillReadable = await runCli(["blog", "show", "linked", "--json"], {
    cwd: project.root,
  });
  assert.equal(stillReadable.code, 0, stillReadable.stdout);
});

test("预览权限错误、系统读取失败和取消均无持久变更", async (t) => {
  const project = await fixture(t);
  const file = await project.write("private.md", article());
  await chmod(file, 0);
  try {
    const result = await runCli(
      ["blog", "delete", "private", "--dry-run", "--json"],
      { cwd: project.root },
    );
    assert.equal(result.code, 4, result.stdout);
    assert.equal(JSON.parse(result.stdout).error.code, "PERMISSION_DENIED");
  } finally {
    await chmod(file, 0o600);
  }
  const preload = join(project.root, "read-fault.cjs");
  await writeFile(
    preload,
    `const fs = require('node:fs/promises'); const delay = require('node:timers/promises').setTimeout; const original = fs.readFile; fs.readFile = async (path, options) => { if (path === process.env.YOHO_FAULT_TARGET) { if (process.env.YOHO_READ_ERROR) throw Object.assign(new Error('simulated disk read failure'), {code:'EIO'}); process.stderr.write('test: read pending\\n'); await delay(5000, undefined, {signal:options.signal}); } return original(path,options); };`,
  );
  const before = await snapshot(project.root);
  const env = { NODE_OPTIONS: `--require=${preload}`, YOHO_FAULT_TARGET: file };
  const failure = await runCli(
    ["blog", "delete", "private", "--dry-run", "--json"],
    { cwd: project.root, env: { ...env, YOHO_READ_ERROR: "1" } },
  );
  assert.equal(failure.code, 5, failure.stdout);
  assert.equal(JSON.parse(failure.stdout).error.code, "IO_ERROR");
  const { child, result } = await startCli(
    ["blog", "delete", "private", "--dry-run", "--json"],
    { cwd: project.root, env },
  );
  child.stderr.on("data", (chunk) => {
    if (chunk.includes("test: read pending")) child.kill("SIGINT");
  });
  const cancelled = await result;
  assert.equal(cancelled.code, 130, JSON.stringify(cancelled));
  assert.equal(JSON.parse(cancelled.stdout).error.code, "CANCELLED");
  assert.deepEqual(await snapshot(project.root), before);
});

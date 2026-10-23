import test from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  readdir,
  stat,
  writeFile,
  mkdir,
  symlink,
  chmod,
  utimes,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixture, article, runCli, startCli } from "./support.mjs";

test("授权条件删除只移除目标，返回原版本并保留目录、图片和其他文章", async (t) => {
  const project = await fixture(t);
  const file = await project.write("nested/target.mdx", article());
  const other = await project.write("other.md", article({ title: "其他文章" }));
  const image = await project.write(
    "nested/image.png",
    Buffer.from([0, 1, 255]),
  );
  const before = await runCli(["blog", "show", "nested/target", "--json"], {
    cwd: project.root,
  });
  const target = JSON.parse(before.stdout).data;
  const result = await runCli(
    [
      "blog",
      "delete",
      "nested/target",
      "--yes",
      "--if-match",
      target.revision,
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    data: {
      id: "nested/target",
      path: file,
      revision: target.revision,
      dryRun: false,
      deleted: true,
    },
  });
  await assert.rejects(readFile(file), { code: "ENOENT" });
  assert.equal((await stat(dirname(file))).isDirectory(), true);
  assert.deepEqual(await readFile(image), Buffer.from([0, 1, 255]));
  assert.equal(await readFile(other, "utf8"), article({ title: "其他文章" }));
  assert.deepEqual(await readdir(dirname(file)), ["image.png"]);
  for (const command of [["show"], ["delete", "--yes"]]) {
    const result = await runCli(
      ["blog", command[0], "nested/target", ...command.slice(1), "--json"],
      { cwd: project.root },
    );
    assert.equal(result.code, 3, result.stdout);
    assert.equal(JSON.parse(result.stdout).error.code, "ARTICLE_NOT_FOUND");
  }
  const listed = await runCli(["blog", "list", "--json"], {
    cwd: project.root,
  });
  assert.deepEqual(
    JSON.parse(listed.stdout).data.items.map((item) => item.id),
    ["other"],
  );
});

test("缺少删除授权直接失败，预览优先于授权，旧版本不删除当前文章", async (t) => {
  const project = await fixture(t);
  const file = await project.write("target.md", article());
  const before = await runCli(["blog", "show", "target", "--json"], {
    cwd: project.root,
  });
  const old = JSON.parse(before.stdout).data.revision;
  const missing = await runCli(["blog", "delete", "target", "--json"], {
    cwd: project.root,
  });
  assert.equal(missing.code, 2, missing.stdout);
  assert.equal(JSON.parse(missing.stdout).error.code, "INVALID_ARGUMENT");
  const preview = await runCli(
    ["blog", "delete", "target", "--yes", "--dry-run", "--json"],
    { cwd: project.root },
  );
  assert.equal(preview.code, 0, preview.stdout);
  assert.equal(JSON.parse(preview.stdout).data.deleted, false);
  assert.equal(await readFile(file, "utf8"), article());
  const current = article({ title: "预览后修改", body: "新的正文" });
  await writeFile(file, current);
  const stale = await runCli(
    ["blog", "delete", "target", "--yes", "--if-match", old, "--json"],
    { cwd: project.root },
  );
  assert.equal(stale.code, 3, stale.stdout);
  assert.equal(JSON.parse(stale.stdout).error.code, "ARTICLE_CONFLICT");
  assert.equal(stale.stderr, "");
  assert.equal(await readFile(file, "utf8"), current);
  assert.deepEqual(await readdir(project.content), ["target.md"]);
  const text = await runCli(
    ["--project", project.root, "blog", "delete", "target", "--yes"],
    { cwd: project.content },
  );
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /已删除 target/);
  assert.match(text.stdout, /版本/);
});

test("删除授权不能绕过损坏、歧义、普通文件和路径边界校验，其他坏文章不阻塞目标", async (t) => {
  const project = await fixture(t);
  const original = article();
  const target = await project.write("nested/target.md", original);
  const bad = await project.write("bad.md", "---\ntitle: [\n---\n");
  await project.write("duplicate.md", original);
  await project.write("duplicate.mdx", original);
  await mkdir(join(project.content, "directory.md"));
  await symlink(target, join(project.content, "linked.md"));
  await symlink(dirname(target), join(project.content, "linked-parent"));
  const outside = join(project.root, "outside.md");
  await writeFile(outside, original);
  await symlink(outside, join(project.content, "escape.md"));
  await symlink(
    join(project.content, "absent.md"),
    join(project.content, "dangling.md"),
  );
  for (const [id, error, code] of [
    ["missing", "ARTICLE_NOT_FOUND", 3],
    ["new/missing", "ARTICLE_NOT_FOUND", 3],
    ["bad", "ARTICLE_INVALID", 3],
    ["duplicate", "ARTICLE_ID_AMBIGUOUS", 3],
    ["directory", "ARTICLE_INVALID", 3],
    ["linked", "ARTICLE_INVALID", 3],
    ["linked-parent/target", "ARTICLE_INVALID", 3],
    ["dangling", "ARTICLE_INVALID", 3],
    ["escape", "PATH_OUTSIDE_CONTENT", 2],
    ["../outside", "INVALID_ARGUMENT", 2],
  ]) {
    const result = await runCli(["blog", "delete", id, "--yes", "--json"], {
      cwd: project.root,
    });
    assert.equal(result.code, code, `${id}: ${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).error.code, error);
    assert.equal(result.stderr, "");
    assert.equal(await readFile(target, "utf8"), original);
    assert.equal(await readFile(outside, "utf8"), original);
  }
  const deleted = await runCli(
    ["blog", "delete", "nested/target", "--yes", "--json"],
    { cwd: project.root },
  );
  assert.equal(deleted.code, 0, deleted.stdout);
  assert.equal(await readFile(bad, "utf8"), "---\ntitle: [\n---\n");
});

test("删除提交权限和 I/O 错误保持原文并释放锁，后续请求可重试", async (t) => {
  const project = await fixture(t);
  const source = article();
  const file = await project.write("target.md", source);
  const args = ["blog", "delete", "target", "--yes", "--json"];
  await chmod(project.content, 0o500);
  try {
    const denied = await runCli(args, { cwd: project.root });
    assert.equal(denied.code, 4, denied.stdout);
    assert.equal(JSON.parse(denied.stdout).error.code, "PERMISSION_DENIED");
  } finally {
    await chmod(project.content, 0o700);
  }
  const preload = join(project.root, "unlink-fault.cjs");
  await writeFile(
    preload,
    `const fs=require('node:fs/promises');const original=fs.unlink;fs.unlink=async(path,...args)=>{if(path===process.env.YOHO_FAULT_TARGET)throw Object.assign(new Error('delete commit failure'),{code:process.env.YOHO_FAULT_CODE});return original(path,...args)};`,
  );
  for (const [fault, exit, code] of [
    ["EACCES", 4, "PERMISSION_DENIED"],
    ["EIO", 5, "IO_ERROR"],
  ]) {
    const result = await runCli(args, {
      cwd: project.root,
      env: {
        NODE_OPTIONS: `--require=${preload}`,
        YOHO_FAULT_TARGET: file,
        YOHO_FAULT_CODE: fault,
      },
    });
    assert.equal(result.code, exit, result.stdout);
    assert.equal(JSON.parse(result.stdout).error.code, code);
    assert.equal(result.stderr, "");
    assert.equal(await readFile(file, "utf8"), source);
    assert.deepEqual(await readdir(project.content), ["target.md"]);
  }
  const retry = await runCli(args, { cwd: project.root });
  assert.equal(retry.code, 0, retry.stdout);
});

async function pendingCli(args, { cwd, env }) {
  const operation = await startCli(args, { cwd, env });
  await Promise.race([
    new Promise((resolvePending) =>
      operation.child.stderr.on("data", (chunk) => {
        if (chunk.includes("test: pending")) resolvePending();
      }),
    ),
    operation.result.then((result) => {
      throw new Error(
        `Operation ended before pending marker: ${JSON.stringify(result)}`,
      );
    }),
  ]);
  return operation;
}

test("删除提交前取消保持完整原文、释放文章锁且可重试", async (t) => {
  const project = await fixture(t);
  const source = article();
  const file = await project.write("target.md", source);
  const preload = join(project.root, "cancel.cjs");
  await writeFile(
    preload,
    `const fs=require('node:fs/promises');const delay=require('node:timers/promises').setTimeout;const original=fs.readFile;let reads=0;fs.readFile=async(path,options)=>{if(path===process.env.YOHO_FAULT_TARGET&&++reads===2){process.stderr.write('test: pending\\n');await delay(5000,undefined,{signal:options.signal})}return original(path,options)};`,
  );
  const args = ["blog", "delete", "target", "--yes", "--json"];
  const operation = await pendingCli(args, {
    cwd: project.root,
    env: { NODE_OPTIONS: `--require=${preload}`, YOHO_FAULT_TARGET: file },
  });
  assert.equal(await readFile(file, "utf8"), source);
  operation.child.kill("SIGINT");
  const cancelled = await operation.result;
  assert.equal(cancelled.code, 130, JSON.stringify(cancelled));
  assert.equal(JSON.parse(cancelled.stdout).error.code, "CANCELLED");
  assert.equal(await readFile(file, "utf8"), source);
  assert.deepEqual(await readdir(project.content), ["target.md"]);
  const retry = await runCli(args, { cwd: project.root });
  assert.equal(retry.code, 0, retry.stdout);
});

test("删除提交前重读发现外部变化时报告冲突并保留新内容", async (t) => {
  const project = await fixture(t);
  const file = await project.write("target.md", article());
  const next = article({ title: "外部修改", body: "完整的新正文" });
  const preload = join(project.root, "change.cjs");
  await writeFile(
    preload,
    `const fs=require('node:fs/promises');const original=fs.readFile;let reads=0;fs.readFile=async(path,options)=>{if(path===process.env.YOHO_FAULT_TARGET&&++reads===2)await fs.writeFile(path,process.env.YOHO_REPLACEMENT);return original(path,options)};`,
  );
  const result = await runCli(["blog", "delete", "target", "--yes", "--json"], {
    cwd: project.root,
    env: {
      NODE_OPTIONS: `--require=${preload}`,
      YOHO_FAULT_TARGET: file,
      YOHO_REPLACEMENT: next,
    },
  });
  assert.equal(result.code, 3, result.stdout);
  assert.equal(JSON.parse(result.stdout).error.code, "ARTICLE_CONFLICT");
  assert.equal(await readFile(file, "utf8"), next);
  assert.deepEqual(await readdir(project.content), ["target.md"]);
});

test("更新与删除持同一旧版本竞争时不能同时成功，两个提交顺序均保护版本", async (t) => {
  for (const first of ["update", "delete"]) {
    const project = await fixture(t);
    const file = await project.write("target.md", article());
    const before = await runCli(["blog", "show", "target", "--json"], {
      cwd: project.root,
    });
    const revision = JSON.parse(before.stdout).data.revision;
    const preload = join(project.root, "pending.cjs");
    await writeFile(
      preload,
      `const fs=require('node:fs/promises');const delay=require('node:timers/promises').setTimeout;const original=fs.readFile;let pending=false;fs.readFile=async(path,options)=>{if(path===process.env.YOHO_FAULT_TARGET&&!pending){pending=true;process.stderr.write('test: pending\\n');await delay(400,undefined,{signal:options.signal})}return original(path,options)};`,
    );
    const update = [
      "blog",
      "update",
      "target",
      "--title",
      "新的文章标题",
      "--if-match",
      revision,
      "--json",
    ];
    const remove = [
      "blog",
      "delete",
      "target",
      "--yes",
      "--if-match",
      revision,
      "--json",
    ];
    const operation = await pendingCli(first === "update" ? update : remove, {
      cwd: project.root,
      env: { NODE_OPTIONS: `--require=${preload}`, YOHO_FAULT_TARGET: file },
    });
    const second = runCli(first === "update" ? remove : update, {
      cwd: project.root,
    });
    const [winner, loser] = await Promise.all([operation.result, second]);
    assert.equal(winner.code, 0, winner.stdout);
    assert.equal(loser.code, 3, loser.stdout);
    assert.equal(
      JSON.parse(loser.stdout).error.code,
      first === "update" ? "ARTICLE_CONFLICT" : "ARTICLE_NOT_FOUND",
    );
    if (first === "update") {
      const shown = await runCli(["blog", "show", "target", "--json"], {
        cwd: project.root,
      });
      assert.equal(
        JSON.parse(shown.stdout).data.metadata.title,
        "新的文章标题",
      );
    } else await assert.rejects(readFile(file), { code: "ENOENT" });
    assert.ok(
      (await readdir(project.content)).every(
        (name) => !name.endsWith(".lock") && !name.endsWith(".tmp"),
      ),
    );
  }
});

test("删除竞争创建不会覆盖已有文章，成功删除后另一扩展名可完整创建", async (t) => {
  const project = await fixture(t);
  const file = await project.write("target.md", article());
  const preload = join(project.root, "pending.cjs");
  await writeFile(
    preload,
    `const fs=require('node:fs/promises');const delay=require('node:timers/promises').setTimeout;const original=fs.readFile;let pending=false;fs.readFile=async(path,options)=>{if(path===process.env.YOHO_FAULT_TARGET&&!pending){pending=true;process.stderr.write('test: pending\\n');await delay(400,undefined,{signal:options.signal})}return original(path,options)};`,
  );
  const operation = await pendingCli(
    ["blog", "delete", "target", "--yes", "--json"],
    {
      cwd: project.root,
      env: { NODE_OPTIONS: `--require=${preload}`, YOHO_FAULT_TARGET: file },
    },
  );
  const creation = [
    "blog",
    "create",
    "target",
    "--title",
    "新的草稿",
    "--description",
    "",
    "--published-at",
    "2026-10-23",
    "--format",
    "mdx",
    "--json",
  ];
  const blocked = await runCli(creation, { cwd: project.root });
  assert.equal(blocked.code, 3, blocked.stdout);
  assert.equal(JSON.parse(blocked.stdout).error.code, "ARTICLE_ALREADY_EXISTS");
  const deleted = await operation.result;
  assert.equal(deleted.code, 0, deleted.stdout);
  const [created, duplicate] = await Promise.all([
    runCli(creation, { cwd: project.root }),
    runCli(creation, { cwd: project.root }),
  ]);
  assert.equal(
    [created, duplicate].filter((result) => result.code === 0).length,
    1,
    JSON.stringify([created, duplicate]),
  );
  const shown = await runCli(["blog", "show", "target", "--json"], {
    cwd: project.root,
  });
  assert.equal(shown.code, 0, shown.stdout);
  assert.equal(JSON.parse(shown.stdout).data.metadata.title, "新的草稿");
  assert.deepEqual(await readdir(project.content), ["target.mdx"]);
});

test("并发删除只成功一次，等待文章锁时取消不影响持锁文章", async (t) => {
  const project = await fixture(t);
  const source = article();
  const file = await project.write("target.md", source);
  const preload = join(project.root, "pending.cjs");
  await writeFile(
    preload,
    `const fs=require('node:fs/promises');const delay=require('node:timers/promises').setTimeout;const original=fs.readFile;let pending=false;fs.readFile=async(path,options)=>{if(path===process.env.YOHO_FAULT_TARGET&&!pending){pending=true;process.stderr.write('test: pending\\n');await delay(5000,undefined,{signal:options.signal})}return original(path,options)};`,
  );
  const args = ["blog", "delete", "target", "--yes", "--json"];
  const holder = await pendingCli(args, {
    cwd: project.root,
    env: { NODE_OPTIONS: `--require=${preload}`, YOHO_FAULT_TARGET: file },
  });
  const waitPreload = join(project.root, "waiting.cjs");
  await writeFile(
    waitPreload,
    `const fs=require('node:fs');const mkdir=fs.mkdir;fs.mkdir=(path,...args)=>{if(String(path).endsWith('.lock'))process.stderr.write('test: pending\\n');return mkdir(path,...args)};`,
  );
  const waiter = await pendingCli(args, {
    cwd: project.root,
    env: { NODE_OPTIONS: `--require=${waitPreload}` },
  });
  waiter.child.kill("SIGINT");
  const cancelled = await waiter.result;
  assert.equal(cancelled.code, 130, JSON.stringify(cancelled));
  assert.equal(JSON.parse(cancelled.stdout).error.code, "CANCELLED");
  assert.equal(await readFile(file, "utf8"), source);
  holder.child.kill("SIGINT");
  assert.equal((await holder.result).code, 130);
  const results = await Promise.all([
    runCli(args, { cwd: project.root }),
    runCli(args, { cwd: project.root }),
  ]);
  assert.equal(
    results.filter((result) => result.code === 0).length,
    1,
    JSON.stringify(results),
  );
  const loser = results.find((result) => result.code !== 0);
  assert.equal(loser.code, 3, loser.stdout);
  assert.equal(JSON.parse(loser.stdout).error.code, "ARTICLE_NOT_FOUND");
  assert.deepEqual(await readdir(project.content), []);
});

test("崩溃后未过期文章锁超时，过期后可安全重试删除", async (t) => {
  const project = await fixture(t);
  const source = article();
  const file = await project.write("target.md", source);
  const preload = join(project.root, "pending.cjs");
  await writeFile(
    preload,
    `const fs=require('node:fs/promises');const delay=require('node:timers/promises').setTimeout;const original=fs.readFile;fs.readFile=async(path,options)=>{if(path===process.env.YOHO_FAULT_TARGET){process.stderr.write('test: pending\\n');await delay(5000,undefined,{signal:options.signal})}return original(path,options)};`,
  );
  const args = ["blog", "delete", "target", "--yes", "--json"];
  const holder = await pendingCli(args, {
    cwd: project.root,
    env: { NODE_OPTIONS: `--require=${preload}`, YOHO_FAULT_TARGET: file },
  });
  holder.child.kill("SIGKILL");
  await holder.result;
  const timeout = await runCli(args, { cwd: project.root });
  assert.equal(timeout.code, 3, timeout.stdout);
  assert.equal(JSON.parse(timeout.stdout).error.code, "ARTICLE_CONFLICT");
  assert.equal(await readFile(file, "utf8"), source);
  const [lock] = (await readdir(project.content)).filter((name) =>
    name.endsWith(".lock"),
  );
  assert.ok(lock);
  const expired = new Date(Date.now() - 30_000);
  await utimes(join(project.content, lock), expired, expired);
  const retry = await runCli(args, { cwd: project.root });
  assert.equal(retry.code, 0, retry.stdout);
  assert.deepEqual(await readdir(project.content), []);
});

test("删除前检测到文章锁失效时保留目标并允许后续重试", async (t) => {
  const project = await fixture(t);
  const source = article();
  const file = await project.write("target.md", source);
  const preload = join(project.root, "lost-lock.cjs");
  await writeFile(
    preload,
    `const fs=require('node:fs/promises');const path=require('node:path');const delay=require('node:timers/promises').setTimeout;const original=fs.readFile;let reads=0;fs.readFile=async(target,options)=>{if(target===process.env.YOHO_FAULT_TARGET&&++reads===2){for(const name of await fs.readdir(path.dirname(target)))if(name.endsWith('.lock'))await fs.rm(path.join(path.dirname(target),name),{recursive:true});await delay(5500,undefined,{signal:options.signal})}return original(target,options)};`,
  );
  const args = ["blog", "delete", "target", "--yes", "--json"];
  const invalid = await runCli(args, {
    cwd: project.root,
    env: { NODE_OPTIONS: `--require=${preload}`, YOHO_FAULT_TARGET: file },
  });
  assert.equal(invalid.code, 3, invalid.stdout);
  assert.equal(JSON.parse(invalid.stdout).error.code, "ARTICLE_CONFLICT");
  assert.equal(await readFile(file, "utf8"), source);
  const retry = await runCli(args, { cwd: project.root });
  assert.equal(retry.code, 0, retry.stdout);
});

test("安装包完成草稿创建、组合编辑、发布、预览和条件删除的完整流程", async (t) => {
  const project = await fixture(t);
  const created = await runCli(
    [
      "blog",
      "create",
      "nested/article",
      "--title",
      "草稿标题",
      "--description",
      "初始描述",
      "--published-at",
      "2026-10-23",
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(created.code, 0, created.stdout);
  const original = JSON.parse(created.stdout).data;
  const input = join(project.root, "body.mdx");
  const body = "# 新的正文\n\n![图片](../image.png)\n";
  await writeFile(input, body);
  const edited = await runCli(
    [
      "blog",
      "update",
      "nested/article",
      "--title",
      "完整文章",
      "--description",
      "新的描述",
      "--tag",
      "CLI",
      "--body-file",
      input,
      "--status",
      "published",
      "--if-match",
      original.revision,
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(edited.code, 0, edited.stdout);
  const revision = JSON.parse(edited.stdout).data.revision;
  const shown = await runCli(["blog", "show", "nested/article", "--json"], {
    cwd: project.root,
  });
  const current = JSON.parse(shown.stdout).data;
  assert.equal(current.revision, revision);
  assert.equal(current.content, body);
  assert.equal(current.metadata.title, "完整文章");
  assert.equal(current.metadata.status, "published");
  assert.equal(current.metadata.draft, false);
  const blogRoot = resolve(process.env.YOHO_BLOG_PROJECT ?? "../yoho-blog");
  const script = `import {readFile} from 'node:fs/promises';const {parsePublishedBlogSources}=await import(process.argv[1]);process.stdout.write(JSON.stringify(parsePublishedBlogSources([{id:'nested/article',source:await readFile(process.argv[2],'utf8')}])));`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      pathToFileURL(join(blogRoot, "src/lib/content.ts")).href,
      current.path,
    ],
    { cwd: blogRoot, env: { ...process.env, BLOG_CONTENT_SOURCE: "local" } },
  );
  const [loaded] = JSON.parse(stdout);
  assert.equal(loaded.id, "nested/article");
  assert.equal(loaded.data.title, "完整文章");
  const preview = await runCli(
    ["blog", "delete", "nested/article", "--dry-run", "--json"],
    { cwd: project.root },
  );
  assert.equal(preview.code, 0, preview.stdout);
  assert.equal(JSON.parse(preview.stdout).data.revision, revision);
  const removed = await runCli(
    [
      "blog",
      "delete",
      "nested/article",
      "--yes",
      "--if-match",
      revision,
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(removed.code, 0, removed.stdout);
  assert.equal(JSON.parse(removed.stdout).data.deleted, true);
  assert.equal(await readFile(input, "utf8"), body);
  assert.deepEqual(await readdir(join(project.content, "nested")), []);
});

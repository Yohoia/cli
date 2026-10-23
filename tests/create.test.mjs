import test from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  readdir,
  mkdir,
  symlink,
  chmod,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fixture, article, runCli, startCli } from "./support.mjs";

const required = [
  "--title",
  ' 中文 "标题" ',
  "--description",
  "  原样描述  ",
  "--published-at",
  "2026-10-23",
];

test("创建完整草稿且 show 返回同一文章、原样正文和规范标签", async (t) => {
  const project = await fixture(t);
  const input = join(project.root, "input.md");
  const body = "\r\n<Component />\n![图片](../asset.png)  \n末尾";
  await writeFile(input, body);
  const created = await runCli(
    [
      "blog",
      "create",
      "nested/draft",
      ...required,
      "--format",
      "mdx",
      "--body-file",
      "input.md",
      "--tag",
      " TS ",
      "--tag",
      "TS",
      "--tag",
      "ts",
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(created.code, 0, created.stdout);
  assert.equal(created.stderr, "");
  const result = JSON.parse(created.stdout).data;
  assert.equal(result.id, "nested/draft");
  assert.equal(result.path, join(project.content, "nested/draft.mdx"));
  assert.equal(result.content, body);
  assert.deepEqual(result.metadata, {
    title: '中文 "标题"',
    description: "  原样描述  ",
    publishedAt: "2026-10-23T00:00:00.000Z",
    status: "draft",
    draft: true,
    language: "zh",
    tags: ["TS", "ts"],
  });
  const shown = await runCli(["blog", "show", "nested/draft", "--json"], {
    cwd: project.root,
  });
  assert.deepEqual(JSON.parse(shown.stdout).data, result);
  assert.equal(await readFile(input, "utf8"), body);
  const source = await readFile(result.path, "utf8");
  assert.ok(source.endsWith("---\n" + body));
});

test("日期校验拒绝自动滚动和无时区，并接受 UTC 日期及显式偏移", async (t) => {
  const project = await fixture(t);
  for (const date of [
    "2026-02-30",
    "2025-02-29",
    "2026-10-23T12:30:00",
    "2026-02-30T12:30:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T12:90:00Z",
    "2026-02-30T09:30+08:00",
    "2026-10-23T09:30",
    "2026-10-23T24:00+08:00",
    "2026-10-23T09:60+08:00",
    "2026-10-23T09:30:60.123456+08:00",
    "2026-10-23T09:30+24:00",
    "2026-10-23T09:30+08:60",
    "October 23, 2026",
  ]) {
    const result = await runCli(
      [
        "blog",
        "create",
        "entry",
        ...required,
        "--published-at",
        date,
        "--json",
      ],
      { cwd: project.root },
    );
    assert.equal(result.code, 2, `${date}: ${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).error.code, "INVALID_ARGUMENT");
    assert.deepEqual(await readdir(project.content), []);
  }
  const good = await runCli(
    [
      "blog",
      "create",
      "offset",
      ...required,
      "--published-at",
      "2024-02-29T01:02:03.123+08:00",
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(good.code, 0, good.stdout);
  const data = JSON.parse(good.stdout).data;
  assert.equal(data.metadata.publishedAt, "2024-02-28T17:02:03.123Z");
  assert.equal(data.content, "");
  assert.deepEqual(data.metadata.tags, []);
  assert.equal(data.path, join(project.content, "offset.md"));
});

test("创建接受带时区的分钟精度时间并转换为 UTC", async (t) => {
  const project = await fixture(t);
  const created = await runCli(
    [
      "blog",
      "create",
      "minute",
      ...required,
      "--published-at",
      "2026-10-23T09:30+08:00",
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(created.code, 0, created.stdout);
  const data = JSON.parse(created.stdout).data;
  assert.equal(data.metadata.publishedAt, "2026-10-23T01:30:00.000Z");
  const shown = await runCli(["blog", "show", "minute", "--json"], {
    cwd: project.root,
  });
  assert.deepEqual(JSON.parse(shown.stdout).data, data);
});

test("创建接受超过毫秒精度的带时区时间并保留可表示的毫秒", async (t) => {
  const project = await fixture(t);
  const created = await runCli(
    [
      "blog",
      "create",
      "fraction",
      ...required,
      "--published-at",
      "2026-10-23T09:30:00.123456+08:00",
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(created.code, 0, created.stdout);
  const data = JSON.parse(created.stdout).data;
  assert.equal(data.metadata.publishedAt, "2026-10-23T01:30:00.123Z");
  const shown = await runCli(["blog", "show", "fraction", "--json"], {
    cwd: project.root,
  });
  assert.deepEqual(JSON.parse(shown.stdout).data, data);
});

test("已有任一扩展名、损坏文章、目录与歧义均不可覆盖", async (t) => {
  const project = await fixture(t);
  const existing = await project.write("entry.mdx", "损坏的原文");
  const run = (id) =>
    runCli(["blog", "create", id, ...required, "--json"], {
      cwd: project.root,
    });
  let result = await run("entry");
  assert.equal(result.code, 3, result.stdout);
  assert.equal(JSON.parse(result.stdout).error.code, "ARTICLE_ALREADY_EXISTS");
  assert.equal(await readFile(existing, "utf8"), "损坏的原文");
  await project.write("entry.md", article());
  result = await run("entry");
  assert.equal(JSON.parse(result.stdout).error.code, "ARTICLE_ID_AMBIGUOUS");
  await mkdir(join(project.content, "directory.md"));
  result = await run("directory");
  assert.equal(JSON.parse(result.stdout).error.code, "ARTICLE_INVALID");
  const newResult = await run("unrelated");
  assert.equal(newResult.code, 0, newResult.stdout);
  const repeat = await run("unrelated");
  assert.equal(JSON.parse(repeat.stdout).error.code, "ARTICLE_ALREADY_EXISTS");
});

test("两个独立进程创建相同标识不同扩展名时只有一个完整草稿", async (t) => {
  const project = await fixture(t);
  const preload = join(project.root, "slow.cjs");
  await writeFile(
    preload,
    `const fs=require('node:fs/promises');const delay=require('node:timers/promises').setTimeout;const open=fs.open;fs.open=async(...args)=>{const file=await open(...args);const write=file.writeFile.bind(file);file.writeFile=async(...a)=>{await delay(150);return write(...a)};return file};`,
  );
  const results = await Promise.all(
    ["md", "mdx"].map((format) =>
      runCli(
        [
          "blog",
          "create",
          "nested/entry",
          ...required,
          "--format",
          format,
          "--json",
        ],
        { cwd: project.root, env: { NODE_OPTIONS: `--require=${preload}` } },
      ),
    ),
  );
  assert.equal(
    results.filter((r) => r.code === 0).length,
    1,
    JSON.stringify(results),
  );
  const loser = results.find((r) => r.code !== 0);
  assert.equal(loser.code, 3, loser.stdout);
  assert.equal(JSON.parse(loser.stdout).error.code, "ARTICLE_ALREADY_EXISTS");
  const shown = await runCli(["blog", "show", "nested/entry", "--json"], {
    cwd: project.root,
  });
  assert.equal(shown.code, 0, shown.stdout);
  assert.equal(JSON.parse(shown.stdout).data.metadata.title, '中文 "标题"');
  assert.equal((await readdir(join(project.content, "nested"))).length, 1);
});

test("原文及内容目录内文件和父目录别名更新共享同一版本锁", async (t) => {
  const project = await fixture(t);
  await project.write("nested/entry.md", article());
  await symlink(
    join(project.content, "nested/entry.md"),
    join(project.content, "alias.md"),
  );
  await symlink(
    join(project.content, "nested"),
    join(project.content, "alias-dir"),
  );
  const before = JSON.parse(
    (
      await runCli(["blog", "show", "nested/entry", "--json"], {
        cwd: project.root,
      })
    ).stdout,
  ).data;
  const preload = join(project.root, "slow.cjs");
  await writeFile(
    preload,
    `const fs=require('node:fs/promises');const delay=require('node:timers/promises').setTimeout;const rename=fs.rename;fs.rename=async(...args)=>{await delay(150);return rename(...args)};`,
  );
  const results = await Promise.all(
    ["nested/entry", "alias", "alias-dir/entry"].map((id, index) =>
      runCli(
        [
          "blog",
          "update",
          id,
          "--title",
          `标题 ${index}`,
          "--if-match",
          before.revision,
          "--json",
        ],
        { cwd: project.root, env: { NODE_OPTIONS: `--require=${preload}` } },
      ),
    ),
  );
  assert.equal(
    results.filter((r) => r.code === 0).length,
    1,
    JSON.stringify(results),
  );
  assert.ok(
    results
      .filter((r) => r.code !== 0)
      .every((r) => JSON.parse(r.stdout).error.code === "ARTICLE_CONFLICT"),
  );
});

test("列表忽略暂存普通文件且保留名字类似锁的真实文章目录", async (t) => {
  const project = await fixture(t);
  await project.write(".yoho-lock-deadbeef.lock/real.md", article());
  await project.write(".pending.md.yoho-123.tmp", "尚未提交");
  const preload = join(project.root, "disappearing.cjs");
  await writeFile(
    preload,
    `const fs=require('node:fs/promises');const realpath=fs.realpath;fs.realpath=async(path,...args)=>{if(String(path).endsWith('.tmp'))throw Object.assign(new Error('concurrent temp cleanup'),{code:'ENOENT'});return realpath(path,...args)};`,
  );
  const listed = await runCli(["blog", "list", "--json"], {
    cwd: project.root,
    env: { NODE_OPTIONS: `--require=${preload}` },
  });
  assert.equal(listed.code, 0, listed.stdout);
  assert.deepEqual(
    JSON.parse(listed.stdout).data.items.map((x) => x.id),
    [".yoho-lock-deadbeef.lock/real"],
  );
});

test("创建拒绝缺参、无效标题格式标签、无效正文与未识别项目，均无副作用", async (t) => {
  const project = await fixture(t);
  const bad = join(project.root, "bad");
  await writeFile(bad, Buffer.from([0xff]));
  for (const flags of [
    [],
    ["--title", "x"],
    [...required, "--title", " "],
    [...required, "--title", "a\nb"],
    [...required, "--format", "txt"],
    [...required, "--tag", " "],
    [...required, "--status", "published"],
    [...required, "--body-file", bad],
    [...required, "--body-file", project.root],
  ]) {
    const result = await runCli(
      ["blog", "create", "entry", ...flags, "--json"],
      { cwd: project.root },
    );
    assert.equal(result.code, 2, result.stdout);
    assert.equal(JSON.parse(result.stdout).error.code, "INVALID_ARGUMENT");
    assert.deepEqual(await readdir(project.content), []);
  }
  const missing = await runCli(
    [
      "blog",
      "create",
      "entry",
      ...required,
      "--body-file",
      "missing",
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(missing.code, 5, missing.stdout);
  const noProject = await runCli(
    [
      "--project",
      project.content,
      "blog",
      "create",
      "entry",
      ...required,
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(noProject.code, 2, noProject.stdout);
  assert.equal(JSON.parse(noProject.stdout).error.code, "PROJECT_NOT_FOUND");
  assert.deepEqual(await readdir(project.content), []);
});

test("创建在不存在目标时也拒绝越界、最终链接与父目录链接", async (t) => {
  const project = await fixture(t);
  const outside = await fixture(t);
  await project.write("inside/real.md", article());
  await symlink(
    join(project.content, "inside"),
    join(project.content, "inside-link"),
  );
  await symlink(outside.content, join(project.content, "outside-link"));
  await symlink(
    join(project.content, "missing.md"),
    join(project.content, "dangling.md"),
  );
  await symlink(
    join(outside.content, "missing.md"),
    join(project.content, "outside.md"),
  );
  for (const [id, code, error] of [
    ["../escape", 2, "INVALID_ARGUMENT"],
    ["inside-link/new", 3, "ARTICLE_INVALID"],
    ["outside-link/new", 2, "PATH_OUTSIDE_CONTENT"],
    ["dangling", 3, "ARTICLE_INVALID"],
    ["outside", 2, "PATH_OUTSIDE_CONTENT"],
  ]) {
    const result = await runCli(["blog", "create", id, ...required, "--json"], {
      cwd: project.root,
    });
    assert.equal(result.code, code, `${id}: ${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).error.code, error);
  }
  assert.deepEqual(await readdir(join(project.content, "inside")), ["real.md"]);
  assert.deepEqual(await readdir(outside.content), []);
  const text = await runCli(
    ["--project", project.root, "blog", "create", "nested/new", ...required],
    { cwd: outside.root },
  );
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /已创建草稿 nested\/new/);
  const auto = await runCli(["blog", "create", "auto", ...required, "--json"], {
    cwd: join(project.content, "nested"),
  });
  assert.equal(auto.code, 0, auto.stdout);
});

test("创建在提交前保持不可见，取消后无文章或暂存且释放锁", async (t) => {
  const project = await fixture(t);
  await project.write("existing.md", article());
  const preload = join(project.root, "pending.cjs");
  await writeFile(
    preload,
    `const fs=require('node:fs/promises');const delay=require('node:timers/promises').setTimeout;const open=fs.open;fs.open=async(...args)=>{const file=await open(...args);if(String(args[0]).endsWith('.tmp')){const write=file.writeFile.bind(file);file.writeFile=async(data,options)=>{await write(data,options);process.stderr.write('test: pending\\n');await delay(5000,undefined,{signal:options.signal})}}return file};`,
  );
  const operation = await startCli(
    ["blog", "create", "entry", ...required, "--json"],
    { cwd: project.root, env: { NODE_OPTIONS: `--require=${preload}` } },
  );
  const pending = new Promise((resolvePending) =>
    operation.child.stderr.on("data", (chunk) => {
      if (chunk.includes("test: pending")) resolvePending();
    }),
  );
  await pending;
  const shown = await runCli(["blog", "show", "entry", "--json"], {
    cwd: project.root,
  });
  assert.equal(JSON.parse(shown.stdout).error.code, "ARTICLE_NOT_FOUND");
  const listed = await runCli(["blog", "list", "--json"], {
    cwd: project.root,
  });
  assert.equal(listed.code, 0, listed.stdout);
  assert.deepEqual(
    JSON.parse(listed.stdout).data.items.map((x) => x.id),
    ["existing"],
  );
  operation.child.kill("SIGINT");
  const cancelled = await operation.result;
  assert.equal(cancelled.code, 130, JSON.stringify(cancelled));
  assert.equal(JSON.parse(cancelled.stdout).error.code, "CANCELLED");
  assert.deepEqual(await readdir(project.content), ["existing.md"]);
  const retry = await runCli(
    ["blog", "create", "entry", ...required, "--json"],
    { cwd: project.root },
  );
  assert.equal(retry.code, 0, retry.stdout);
});

test("创建的权限与 I/O 错误清理暂存，提交时遇到并发目标绝不覆盖", async (t) => {
  const project = await fixture(t);
  await chmod(project.content, 0o500);
  try {
    const denied = await runCli(
      ["blog", "create", "entry", ...required, "--json"],
      { cwd: project.root },
    );
    assert.equal(denied.code, 4, denied.stdout);
    assert.equal(JSON.parse(denied.stdout).error.code, "PERMISSION_DENIED");
  } finally {
    await chmod(project.content, 0o700);
  }
  assert.deepEqual(await readdir(project.content), []);
  const input = join(project.root, "body.txt");
  await writeFile(input, "正文");
  await chmod(input, 0);
  try {
    const denied = await runCli(
      ["blog", "create", "entry", ...required, "--body-file", input, "--json"],
      { cwd: project.root },
    );
    assert.equal(denied.code, 4, denied.stdout);
  } finally {
    await chmod(input, 0o600);
  }
  const preload = join(project.root, "fault.cjs");
  await writeFile(
    preload,
    `const fs=require('node:fs/promises');fs.link=async()=>{throw Object.assign(new Error('commit I/O failure'),{code:'EIO'})};`,
  );
  const failed = await runCli(
    ["blog", "create", "entry", ...required, "--json"],
    { cwd: project.root, env: { NODE_OPTIONS: `--require=${preload}` } },
  );
  assert.equal(failed.code, 5, failed.stdout);
  assert.equal(JSON.parse(failed.stdout).error.code, "IO_ERROR");
  assert.deepEqual(await readdir(project.content), []);
  await writeFile(
    preload,
    `const fs=require('node:fs/promises');const link=fs.link;fs.link=async(source,target)=>{await fs.writeFile(target,'external writer',{flag:'wx'});return link(source,target)};`,
  );
  const occupied = await runCli(
    ["blog", "create", "entry", ...required, "--json"],
    { cwd: project.root, env: { NODE_OPTIONS: `--require=${preload}` } },
  );
  assert.equal(occupied.code, 3, occupied.stdout);
  assert.equal(
    JSON.parse(occupied.stdout).error.code,
    "ARTICLE_ALREADY_EXISTS",
  );
  assert.equal(
    await readFile(join(project.content, "entry.md"), "utf8"),
    "external writer",
  );
  assert.deepEqual(await readdir(project.content), ["entry.md"]);
});

test("新草稿通过博客实际加载器且不公开，创建结果保留全部字符串语义", async (t) => {
  const project = await fixture(t);
  const description = "行一\n行二\u0085NEL\u2028LS\u2029PS";
  const created = await runCli(
    [
      "blog",
      "create",
      "draft",
      ...required,
      "--description",
      description,
      "--tag",
      "a\u0085b",
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(created.code, 0, created.stdout);
  const data = JSON.parse(created.stdout).data;
  assert.equal(data.metadata.description, description);
  assert.deepEqual(data.metadata.tags, ["a\u0085b"]);
  const blogRoot = resolve(process.env.YOHO_BLOG_PROJECT ?? "../yoho-blog");
  const { pathToFileURL } = await import("node:url");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const script = `import {readFile} from 'node:fs/promises';const {parsePublishedBlogSources}=await import(process.argv[1]);process.stdout.write(JSON.stringify(parsePublishedBlogSources([{id:'draft',source:await readFile(process.argv[2],'utf8')}])));`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      script,
      pathToFileURL(join(blogRoot, "src/lib/content.ts")).href,
      data.path,
    ],
    { cwd: blogRoot, env: { ...process.env, BLOG_CONTENT_SOURCE: "local" } },
  );
  assert.deepEqual(JSON.parse(stdout), []);
});

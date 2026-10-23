import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, utimes, writeFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fixture, runCli, article } from "./support.mjs";

test("文章状态之间可显式转换，状态与草稿标记一次更新且保留其余原文", async (t) => {
  const project = await fixture(t);
  const original =
    "\uFEFF---\r\n# 注释\r\ntitle: 原始标题\r\ndescription: Example\r\nstatus: draft # 状态\r\ndraft: true # 草稿\r\npublishedAt: 2026-10-01\r\nupdatedAt: 2026-10-02\r\nthumbnail: ../../assets/images/cover.png\r\ncustom: {keep: true}\r\n---\r\n正文 ![](../image.png)\r\n";
  const file = await project.write("nested/article.mdx", original);
  await chmod(file, 0o640);
  let prior = original;
  for (const [status, draft] of [
    ["published", false],
    ["archived", true],
    ["draft", true],
    ["archived", true],
    ["published", false],
    ["draft", true],
  ]) {
    const updated = await runCli(
      ["blog", "update", "nested/article", "--status", status, "--json"],
      { cwd: project.root },
    );
    assert.equal(updated.code, 0, updated.stdout);
    assert.equal(updated.stderr, "");
    assert.equal(JSON.parse(updated.stdout).data.changed, true);
    const shown = await runCli(["blog", "show", "nested/article", "--json"], {
      cwd: project.root,
    });
    const data = JSON.parse(shown.stdout).data;
    assert.equal(data.metadata.status, status);
    assert.equal(data.metadata.draft, draft);
    assert.equal(data.revision, JSON.parse(updated.stdout).data.revision);
    const expected = prior
      .replace(
        /status: [^\r\n]+ # 状态/,
        `status: ${JSON.stringify(status)} # 状态`,
      )
      .replace(/draft: [^\r\n]+ # 草稿/, `draft: ${draft} # 草稿`);
    assert.equal(await readFile(file, "utf8"), expected);
    assert.equal((await stat(file)).mode & 0o777, 0o640);
    prior = expected;
  }
});

test("状态与草稿标记按读取默认值判断无变化，同状态的草稿标记不一致时纠正", async (t) => {
  const project = await fixture(t);
  const cases = [
    { source: article(), status: "published", changed: false },
    {
      source: article({ status: "draft", extra: "draft: true\n" }).replace(
        "status: draft\n",
        "",
      ),
      status: "draft",
      changed: false,
    },
    { source: article({ status: "draft" }), status: "draft", changed: true },
    {
      source: article({ extra: "draft: true\n" }),
      status: "published",
      changed: true,
    },
    {
      source: article({ status: "archived", extra: "draft: false\n" }),
      status: "archived",
      changed: true,
    },
  ];
  for (const [index, { source, status, changed }] of cases.entries()) {
    const id = `defaults-${index}`;
    const file = await project.write(`${id}.md`, source);
    await utimes(file, 1_000_000, 1_000_000);
    const before = await stat(file, { bigint: true });
    const original = JSON.parse(
      (await runCli(["blog", "show", id, "--json"], { cwd: project.root }))
        .stdout,
    ).data;
    const result = await runCli(
      ["blog", "update", id, "--status", status, "--json"],
      { cwd: project.root },
    );
    assert.equal(result.code, 0, result.stdout);
    const data = JSON.parse(result.stdout).data;
    assert.equal(data.changed, changed);
    const shown = JSON.parse(
      (await runCli(["blog", "show", id, "--json"], { cwd: project.root }))
        .stdout,
    ).data;
    assert.equal(shown.metadata.status, status);
    assert.equal(shown.metadata.draft, status !== "published");
    if (!changed) {
      assert.equal(await readFile(file, "utf8"), source);
      assert.equal(data.revision, original.revision);
      const after = await stat(file, { bigint: true });
      assert.equal(after.mtimeNs, before.mtimeNs);
      assert.equal(after.ino, before.ino);
    }
  }
});

test("状态与标题正文描述标签组合一次提交；未指定状态不改草稿标记；非法输入整体失败", async (t) => {
  const project = await fixture(t);
  const source = article({ status: "draft", extra: "draft: false\n" });
  const file = await project.write("article.md", source);
  const input = join(project.root, "body.txt");
  await writeFile(input, "新的正文\r\n");
  const titleOnly = await runCli(
    ["blog", "update", "article", "--title", "标题", "--json"],
    { cwd: project.root },
  );
  assert.equal(titleOnly.code, 0, titleOnly.stdout);
  assert.equal(
    await readFile(file, "utf8"),
    source.replace("title: 原始标题", 'title: "标题"'),
  );
  const before = await readFile(file, "utf8");
  for (const args of [
    ["--status", "invalid", "--title", "新标题"],
    ["--status", "published", "--title", ""],
    ["--status", "published", "--body-file", "missing"],
  ]) {
    const result = await runCli(
      ["blog", "update", "article", ...args, "--json"],
      { cwd: project.root },
    );
    assert.notEqual(result.code, 0, result.stdout);
    assert.equal(await readFile(file, "utf8"), before);
  }
  const result = await runCli(
    [
      "blog",
      "update",
      "article",
      "--status",
      "published",
      "--title",
      "新标题",
      "--body-file",
      input,
      "--description",
      "新的描述",
      "--tag",
      "状态管理",
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(result.code, 0, result.stdout);
  const shown = JSON.parse(
    (await runCli(["blog", "show", "article", "--json"], { cwd: project.root }))
      .stdout,
  ).data;
  assert.equal(shown.metadata.title, "新标题");
  assert.equal(shown.metadata.description, "新的描述");
  assert.deepEqual(shown.metadata.tags, ["状态管理"]);
  assert.equal(shown.metadata.status, "published");
  assert.equal(shown.metadata.draft, false);
  assert.equal(shown.content, "新的正文\r\n");
});

test("状态关联到未知字段时整体拒绝，独立别名及继承字段可以独立更新", async (t) => {
  const project = await fixture(t);
  for (const [id, source] of [
    [
      "shared-status",
      article({ status: "&state published", extra: "customState: *state\n" }),
    ],
    [
      "shared-draft",
      article({ extra: "draft: &draftFlag false\ncustomDraft: *draftFlag\n" }),
    ],
  ]) {
    const file = await project.write(`${id}.md`, source);
    const result = await runCli(
      [
        "blog",
        "update",
        id,
        "--status",
        "archived",
        "--title",
        "不会写入",
        "--json",
      ],
      { cwd: project.root },
    );
    assert.equal(result.code, 3, result.stdout);
    assert.equal(JSON.parse(result.stdout).error.code, "ARTICLE_INVALID");
    assert.equal(await readFile(file, "utf8"), source);
  }
  for (const [id, source] of [
    [
      "alias",
      article()
        .replace(
          "status: published",
          "baseStatus: &baseState published\nstatus: *baseState",
        )
        .replace(
          "publishedAt:",
          "baseDraft: &baseDraft false\ndraft: *baseDraft\npublishedAt:",
        ),
    ],
    [
      "merged",
      article().replace(
        "status: published",
        "base: &base {status: published, draft: false}\n<<: *base",
      ),
    ],
    [
      "flow",
      "---\n{title: 原始标题, description: Example, publishedAt: 2026-10-01}\n---\n正文\n",
    ],
  ]) {
    await project.write(`${id}.md`, source);
    const result = await runCli(
      ["blog", "update", id, "--status", "archived", "--json"],
      { cwd: project.root },
    );
    assert.equal(result.code, 0, result.stdout);
    const shown = JSON.parse(
      (await runCli(["blog", "show", id, "--json"], { cwd: project.root }))
        .stdout,
    ).data;
    assert.equal(shown.metadata.status, "archived");
    assert.equal(shown.metadata.draft, true);
  }
});

test("状态更新沿用版本检查，过期无变化仍冲突且相同旧版本并发最多一方成功", async (t) => {
  const project = await fixture(t);
  const file = await project.write("article.md", article());
  const shown = JSON.parse(
    (await runCli(["blog", "show", "article", "--json"], { cwd: project.root }))
      .stdout,
  ).data;
  const results = await Promise.all(
    ["draft", "archived"].map((status) =>
      runCli(
        [
          "blog",
          "update",
          "article",
          "--status",
          status,
          "--if-match",
          shown.revision,
          "--json",
        ],
        { cwd: project.root },
      ),
    ),
  );
  assert.deepEqual(results.map((result) => result.code).sort(), [0, 3]);
  const failure = results.find((result) => result.code === 3);
  assert.equal(JSON.parse(failure.stdout).error.code, "ARTICLE_CONFLICT");
  const current = JSON.parse(
    (await runCli(["blog", "show", "article", "--json"], { cwd: project.root }))
      .stdout,
  ).data;
  const before = await readFile(file, "utf8");
  const staleNoop = await runCli(
    [
      "blog",
      "update",
      "article",
      "--status",
      current.metadata.status,
      "--if-match",
      shown.revision,
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(staleNoop.code, 3, staleNoop.stdout);
  assert.equal(JSON.parse(staleNoop.stdout).error.code, "ARTICLE_CONFLICT");
  assert.equal(await readFile(file, "utf8"), before);
});

test("实际博客加载器按状态展示和隐藏临时文章，恢复发布后保留日期与图片引用", async (t) => {
  const project = await fixture(t);
  const body = "\n![图片](../../assets/images/body.png)\n";
  const file = await project.write(
    "article.md",
    article({
      extra:
        "thumbnail: ../../assets/images/cover.png\nupdatedAt: 2026-10-02\n",
      body,
    }),
  );
  const blogRoot = resolve(process.env.YOHO_BLOG_PROJECT ?? "../yoho-blog");
  const loader = pathToFileURL(join(blogRoot, "src/lib/content.ts")).href;
  const script = `import { readFile } from 'node:fs/promises'; const { parsePublishedBlogSources } = await import(process.argv[1]); process.stdout.write(JSON.stringify(parsePublishedBlogSources([{id:'article',source:await readFile(process.argv[2],'utf8')}])));`;
  for (const [status, visible] of [
    ["draft", false],
    ["published", true],
    ["archived", false],
    ["published", true],
  ]) {
    const updated = await runCli(
      ["blog", "update", "article", "--status", status, "--json"],
      { cwd: project.root },
    );
    assert.equal(updated.code, 0, updated.stdout);
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", script, loader, file],
      { cwd: blogRoot, env: { ...process.env, BLOG_CONTENT_SOURCE: "local" } },
    );
    const entries = JSON.parse(stdout);
    assert.equal(entries.length, visible ? 1 : 0);
    if (visible) {
      assert.equal(entries[0].data.publishedAt, "2026-10-01T00:00:00.000Z");
      assert.equal(entries[0].data.updatedAt, "2026-10-02T00:00:00.000Z");
      assert.equal(entries[0].data.thumbnail, "/media/cover.png");
    }
    const source = await readFile(file, "utf8");
    assert.match(source, /publishedAt: 2026-10-01\n/);
    assert.match(source, /updatedAt: 2026-10-02\n/);
    assert.match(source, /thumbnail: \.\.\/\.\.\/assets\/images\/cover.png\n/);
    assert.ok(source.endsWith(body));
    const list = await runCli(["blog", "list", "--json"], {
      cwd: project.root,
    });
    assert.equal(JSON.parse(list.stdout).data.items[0].status, status);
    const filtered = await runCli(
      ["blog", "list", "--status", status, "--json"],
      { cwd: project.root },
    );
    assert.equal(JSON.parse(filtered.stdout).data.items.length, 1);
  }
});

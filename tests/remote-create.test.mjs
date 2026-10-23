import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { remoteFixture, runCli, forwardingProxy } from "./remote-support.mjs";

test("installed CLI uploads a Markdown file as a draft without changing the source", async (t) => {
  const api = await remoteFixture(t);
  const token = await api.device();
  const path = join(api.root, "我的文章.md");
  const source =
    "---\ntitle: 远程草稿\nlanguage: zh\ntags: [ignored]\n---\n\n# 正文标题\n\n这是描述来源。\n";
  await writeFile(path, source);
  const created = await runCli(
    ["blog", "create", path, "--json"],
    api.options(token),
  );
  assert.equal(created.code, 0, created.stdout + created.stderr);
  const data = JSON.parse(created.stdout).data;
  assert.equal(data.article.title, "远程草稿");
  assert.equal(data.article.status, "draft");
  assert.match(data.article.description, /描述来源/);
  assert.equal(data.article.content, "\n# 正文标题\n\n这是描述来源。\n");
  assert.match(created.stderr, /tags/);
  assert.equal(await readFile(path, "utf8"), source);
  const again = await runCli(
    ["blog", "create", path, "--json"],
    api.options(token),
  );
  assert.equal(again.code, 0, again.stdout);
  assert.notEqual(JSON.parse(again.stdout).data.article.id, data.article.id);
  const query = await runCli(
    ["blog", "operation", data.requestId, "--json"],
    api.options(token),
  );
  assert.equal(query.code, 0, query.stdout);
  assert.equal(
    JSON.parse(query.stdout).data.result.article.id,
    data.article.id,
  );
});

test("installed CLI rejects empty or malformed documents and unresolved local resources before creating articles", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device(),
    options = api.options(token);
  const cases = [
    ["empty.md", "---\ntitle: 空正文\n---\n \n"],
    ["type.md", "---\ntitle: 42\n---\n正文"],
    ["local.md", "# 标题\n\n正文\n[附件](./secret.pdf)"],
    ["missing.md", "# 标题\n\n正文\n![图](missing.png)"],
    ["html.md", "# 标题\n\n正文\n<img src=local.png>"],
    ["reference.md", "# 标题\n\n正文\n![图][local]\n\n[local]: ./photo.png"],
  ];
  for (const [name, source] of cases) {
    const path = join(api.root, name);
    await writeFile(path, source);
    const result = await runCli(["blog", "create", path, "--json"], options);
    assert.equal(result.code, 3, `${name}: ${result.stdout}`);
    assert.equal(await readFile(path, "utf8"), source);
  }
  const listed = await runCli(["blog", "list", "--json"], options);
  assert.equal(JSON.parse(listed.stdout).data.items.length, 0);
});

test("installed CLI uses headings outside code blocks then the file name for title fallback", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device(),
    options = api.options(token);
  for (const [name, source, title] of [
    [
      "heading.md",
      "```md\n# 代码里的标题\n```\n\n# 真正标题\n\n正文。",
      "真正标题",
    ],
    ["文件名.md", "只有普通段落。", "文件名"],
  ]) {
    const path = join(api.root, name);
    await writeFile(path, source);
    const result = await runCli(["blog", "create", path, "--json"], options);
    assert.equal(result.code, 0, result.stdout);
    assert.equal(JSON.parse(result.stdout).data.article.title, title);
  }
});

test("installed CLI never executes non-YAML frontmatter as code", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device(),
    options = api.options(token);
  const marker = join(api.root, "executed");
  const source = `---js\n(() => { process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(marker)},'executed'); return {title:'危险元数据'}; })()\n---\n\n正文\n`;
  const path = join(api.root, "javascript.md");
  await writeFile(path, source);
  const result = await runCli(["blog", "create", path, "--json"], options);
  assert.equal(result.code, 3, result.stdout);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
});

test("installed CLI rejects invalid UTF-8 and whitespace-only documents before any HTTP request", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device();
  const proxy = await forwardingProxy(t, api.url);
  const options = api.options(token);
  options.env.YOHO_SERVER = proxy.url;
  for (const [name, bytes, message] of [
    ["invalid.md", Buffer.from([0x23, 0x20, 0xff, 0xfe]), /UTF-8/],
    ["whitespace.md", Buffer.from(" \n\t\r\n　\n"), /正文不能为空/],
  ]) {
    const path = join(api.root, name);
    await writeFile(path, bytes);
    const result = await runCli(["blog", "create", path, "--json"], options);
    assert.equal(result.code, 3, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).error.code, "ARTICLE_INVALID");
    assert.match(JSON.parse(result.stdout).error.message, message);
    assert.deepEqual(await readFile(path), bytes);
    assert.equal(proxy.requests.length, 0);
  }
});

test("installed CLI resolves a relative Markdown path from the calling directory and preserves Chinese spaces", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device();
  const directory = join(api.root, "文章 目录");
  await mkdir(directory);
  const path = join(directory, "中文 草稿.md");
  const source = "普通中文正文，标题来自文件名。\n";
  await writeFile(path, source);
  const result = await runCli(
    ["blog", "create", "文章 目录/中文 草稿.md", "--json"],
    api.options(token),
  );
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const article = JSON.parse(result.stdout).data.article;
  assert.equal(article.title, "中文 草稿");
  assert.equal(article.language, "zh");
  assert.equal(article.content, source);
  assert.equal(await readFile(path, "utf8"), source);
  const fetched = await fetch(`${api.url}/v1/cli/articles/${article.id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(fetched.status, 200);
  assert.equal((await fetched.json()).content, source);
});

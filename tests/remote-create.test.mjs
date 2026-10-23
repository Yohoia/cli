import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { remoteFixture, runCli } from "./remote-support.mjs";

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

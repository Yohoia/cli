import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { remoteFixture, runCli, forwardingProxy } from "./remote-support.mjs";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=",
  "base64",
);

test("installed CLI uploads repeated local inline images once and keeps Markdown bytes unchanged", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device();
  const docs = join(api.root, "docs");
  await mkdir(docs);
  await writeFile(join(api.root, "图 片.png"), PNG);
  const source =
    '# 图片文章\n\n正文说明。\n\n![第一张](<../图 片.png> "说明")\n\n![第二张](../图%20片.png)\n\n![外链](https://example.com/photo.png)\n\n```md\n![代码](./missing.png)\n```\n';
  const path = join(docs, "article.md");
  await writeFile(path, source);
  const result = await runCli(
    ["blog", "create", path, "--json"],
    api.options(token),
  );
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const { article } = JSON.parse(result.stdout).data;
  const matches = Array.from(
    article.content.matchAll(/\/v1\/assets\/([0-9a-f-]+)\/content/g),
  );
  assert.equal(matches.length, 2);
  assert.equal(matches[0][1], matches[1][1]);
  assert.match(
    article.content,
    /!\[第一张\]\(<\/v1\/assets\/.*\/content> "说明"\)/,
  );
  assert.ok(article.content.includes("![外链](https://example.com/photo.png)"));
  assert.ok(article.content.includes("![代码](./missing.png)"));
  assert.equal(await readFile(path, "utf8"), source);
  const binary = await fetch(`${api.url}${matches[0][0]}`, {
    headers: { cookie: api.cookie },
  });
  assert.equal(binary.status, 200);
  assert.deepEqual(Buffer.from(await binary.arrayBuffer()), PNG);
  const anonymous = await fetch(`${api.url}${matches[0][0]}`);
  assert.equal(anonymous.status, 401);
});

test("all image inputs are checked before any upload and invalid images leave no article or assets", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device(),
    options = api.options(token);
  const proxy = await forwardingProxy(t, api.url);
  options.env.YOHO_SERVER = proxy.url;
  await writeFile(join(api.root, "valid.png"), PNG);
  await writeFile(join(api.root, "bad.png"), "not a real image");
  const path = join(api.root, "images.md");
  await writeFile(
    path,
    "# 预检\n\n说明\n\n![有效](valid.png)\n\n![无效](bad.png)\n",
  );
  const failed = await runCli(["blog", "create", path, "--json"], options);
  assert.equal(failed.code, 3, failed.stdout);
  assert.equal(JSON.parse(failed.stdout).error.code, "ARTICLE_INVALID");
  assert.equal(
    proxy.requests.length,
    0,
    "preflight errors must happen before any remote request",
  );
  const list = await runCli(["blog", "list", "--json"], options);
  assert.equal(JSON.parse(list.stdout).data.items.length, 0);
  const tooLarge = Buffer.alloc(5 * 1024 * 1024 + 1);
  PNG.copy(tooLarge);
  await writeFile(join(api.root, "bad.png"), tooLarge);
  const large = await runCli(["blog", "create", path, "--json"], options);
  assert.equal(large.code, 3, large.stdout);
  assert.match(large.stdout, /5 MiB/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { remoteFixture, runCli, forwardingProxy } from "./remote-support.mjs";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=",
  "base64",
);
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDl6KKK+uPmj//Z",
  "base64",
);
const WEBP = Buffer.from(
  "UklGRjoAAABXRUJQVlA4IC4AAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8Gyv/0JPwSfgk/hM/+bAgZofOgAA",
  "base64",
);

function imageForm(bytes, mime, name) {
  const body = new FormData();
  body.set("kind", "inline_image");
  body.set("file", new Blob([bytes], { type: mime }), name);
  return body;
}

async function uploadAsset(api, token, operationId, assetId, bytes, mime) {
  return fetch(`${api.url}/v1/cli/uploads/${operationId}/assets`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-asset-id": assetId,
      "x-content-sha256": createHash("sha256").update(bytes).digest("hex"),
    },
    body: imageForm(bytes, mime, "image"),
  });
}

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

test("installed CLI preserves image labels containing code spans when replacing local destinations", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device();
  const proxy = await forwardingProxy(t, api.url);
  const options = api.options(token);
  options.env.YOHO_SERVER = proxy.url;
  await writeFile(join(api.root, "pic.png"), PNG);
  const source =
    '# 图片说明\r\n\r\n说明正文。\r\n\r\n![`[`](pic.png "左括号")\r\n\r\n![` ] `](<pic.png>)\r\n\r\n![![内部](https://example.com/remote.png)](pic.png)\r\n\r\n![说明 \\[转义\\]](pic.png)\r\n';
  const path = join(api.root, "labels.md");
  await writeFile(path, source);
  const created = await runCli(["blog", "create", path, "--json"], options);
  assert.equal(created.code, 0, created.stdout + created.stderr);
  const { article } = JSON.parse(created.stdout).data;
  const urls = article.content.match(/\/v1\/assets\/[0-9a-f-]+\/content/g);
  assert.equal(urls?.length, 4);
  assert.equal(new Set(urls).size, 1);
  assert.equal(article.content, source.replaceAll("pic.png", urls[0]));
  assert.equal(
    proxy.requests.filter(({ url }) => url.includes("/uploads/")).length,
    1,
  );
  assert.equal(await readFile(path, "utf8"), source);
  assert.deepEqual(await readFile(join(api.root, "pic.png")), PNG);
});

test("installed CLI rejects unsupported local HTML resource attributes before any HTTP request", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device();
  const proxy = await forwardingProxy(t, api.url);
  const options = api.options(token);
  options.env.YOHO_SERVER = proxy.url;
  const resources = [
    '<img srcset="./missing.png 1x, ./missing@2x.png 2x">',
    '<picture><source srcset="https://example.com/remote.png 1x, ./missing.png 2x"></picture>',
    '<video poster="/Users/example/private.png"></video>',
    '<object data="./private.pdf"></object>',
    '<img SRCSET="&#46;/missing.png 1x">',
    '<svg><image xlink:href="./missing.png" /></svg>',
    '<script src="./private.js"></script>',
  ];
  for (const [index, resource] of resources.entries()) {
    const source = `# HTML 资源\n\n正文说明。\n\n${resource}\n`;
    const path = join(api.root, `resource-${index}.md`);
    await writeFile(path, source);
    const result = await runCli(["blog", "create", path, "--json"], options);
    assert.equal(result.code, 3, `${resource}: ${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).error.code, "ARTICLE_INVALID");
    assert.equal(await readFile(path, "utf8"), source);
    assert.equal(proxy.requests.length, 0);
  }
});

test("installed CLI preserves remote HTML resources and resource examples without uploading images", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device();
  const proxy = await forwardingProxy(t, api.url);
  const options = api.options(token);
  options.env.YOHO_SERVER = proxy.url;
  const source =
    '# 保留 HTML\n\n正文说明。\n\n<img srcset="https://example.com/a,b.png 1x,https://example.com/large.png 2x">\n\n<video poster="https://example.com/poster.png"></video>\n\n<object data="https://example.com/file.pdf"></object>\n\n<!-- <img srcset="./comment.png 1x"> -->\n\n<pre><code><img src="./example.png" srcset="./example@2x.png 2x"></code></pre>\n\n```html\n<img srcset="./code.png 1x">\n```\n';
  const path = join(api.root, "remote-html.md");
  await writeFile(path, source);
  const result = await runCli(["blog", "create", path, "--json"], options);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).data.article.content, source);
  assert.equal(await readFile(path, "utf8"), source);
  assert.deepEqual(
    proxy.requests.map(({ method, url }) => ({ method, url })),
    [{ method: "POST", url: "/v1/cli/articles" }],
  );
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

test("installed CLI uploads JPEG and WebP while retaining existing PageHush image addresses", async (t) => {
  const api = await remoteFixture(t);
  const token = await api.device();
  const existingResponse = await fetch(`${api.url}/v1/assets`, {
    method: "POST",
    headers: { cookie: api.cookie },
    body: imageForm(PNG, "image/png", "existing.png"),
  });
  assert.equal(
    existingResponse.status,
    201,
    await existingResponse.clone().text(),
  );
  const existing = await existingResponse.json();
  const proxy = await forwardingProxy(t, api.url);
  const options = api.options(token);
  options.env.YOHO_SERVER = proxy.url;
  await writeFile(join(api.root, "photo.jpg"), JPEG);
  await writeFile(join(api.root, "picture.webp"), WEBP);
  const source = `# 图片格式\n\n格式说明。\n\n![JPEG](photo.jpg)\n\n![WebP](picture.webp)\n\n![既有素材](${existing.url})\n`;
  const path = join(api.root, "formats.md");
  await writeFile(path, source);
  const created = await runCli(["blog", "create", path, "--json"], options);
  assert.equal(created.code, 0, created.stdout + created.stderr);
  const article = JSON.parse(created.stdout).data.article;
  assert.ok(article.content.includes(`![既有素材](${existing.url})`));
  assert.equal(
    proxy.requests.filter(({ url }) => url.includes("/uploads/")).length,
    2,
  );
  for (const [label, bytes, mime] of [
    ["JPEG", JPEG, "image/jpeg"],
    ["WebP", WEBP, "image/webp"],
  ]) {
    const url = article.content.match(
      new RegExp(`!\\[${label}\\]\\(([^)]+)\\)`),
    )[1];
    const stored = await fetch(`${api.url}${url}`, {
      headers: { cookie: api.cookie },
    });
    assert.equal(stored.status, 200);
    assert.equal(stored.headers.get("content-type"), mime);
    assert.deepEqual(Buffer.from(await stored.arrayBuffer()), bytes);
  }
  assert.equal(await readFile(path, "utf8"), source);
  assert.deepEqual(await readFile(join(api.root, "photo.jpg")), JPEG);
  assert.deepEqual(await readFile(join(api.root, "picture.webp")), WEBP);
});

test("the asset API rejects changed bytes under the same upload identity and replays the original asset", async (t) => {
  const api = await remoteFixture(t);
  const token = await api.device();
  const operationId = randomUUID();
  const assetId = randomUUID();
  const first = await uploadAsset(
    api,
    token,
    operationId,
    assetId,
    PNG,
    "image/png",
  );
  assert.equal(first.status, 201, await first.clone().text());
  const original = await first.json();
  const changed = await uploadAsset(
    api,
    token,
    operationId,
    assetId,
    JPEG,
    "image/jpeg",
  );
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error, "request_conflict");
  const replay = await uploadAsset(
    api,
    token,
    operationId,
    assetId,
    PNG,
    "image/png",
  );
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), original);
  const stored = await fetch(`${api.url}${original.url}`, {
    headers: { cookie: api.cookie },
  });
  assert.deepEqual(Buffer.from(await stored.arrayBuffer()), PNG);
});

test("installed CLI resumes a partially acknowledged multi-image upload without creating duplicate assets", async (t) => {
  const api = await remoteFixture(t);
  const token = await api.device();
  const uploads = [];
  let dropSecond = true;
  const proxy = await forwardingProxy(t, api.url, (request) => {
    if (request.method !== "POST" || !request.url.includes("/uploads/"))
      return false;
    uploads.push({
      id: request.headers["x-asset-id"],
      hash: request.headers["x-content-sha256"],
    });
    if (dropSecond && uploads.length === 2) {
      dropSecond = false;
      return true;
    }
    return false;
  });
  const options = api.options(token);
  options.env.YOHO_SERVER = proxy.url;
  await writeFile(join(api.root, "first.png"), PNG);
  await writeFile(join(api.root, "second.jpg"), JPEG);
  const source =
    "# 多图恢复\n\n说明。\n\n![第一张](first.png)\n\n![第二张](second.jpg)\n";
  const path = join(api.root, "multiple.md");
  await writeFile(path, source);
  const interrupted = await runCli(["blog", "create", path, "--json"], options);
  assert.equal(interrupted.code, 5, interrupted.stdout + interrupted.stderr);
  const failure = JSON.parse(interrupted.stdout).error;
  assert.equal(failure.code, "IMAGE_UPLOAD_FAILED");
  const requestId = failure.message.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)[0];
  assert.equal(uploads.length, 2);
  assert.equal(
    proxy.requests.some(
      ({ method, url }) => method === "POST" && url === "/v1/cli/articles",
    ),
    false,
  );
  const initialList = await runCli(["blog", "list", "--json"], options);
  assert.equal(JSON.parse(initialList.stdout).data.items.length, 0);
  const pending = await runCli(
    ["blog", "operation", requestId, "--json"],
    options,
  );
  assert.equal(JSON.parse(pending.stdout).data.status, "pending");
  const previous = [];
  for (const [index, bytes, mime] of [
    [0, PNG, "image/png"],
    [1, JPEG, "image/jpeg"],
  ]) {
    const response = await uploadAsset(
      api,
      token,
      requestId,
      uploads[index].id,
      bytes,
      mime,
    );
    assert.equal(response.status, 201, await response.clone().text());
    previous.push(await response.json());
  }
  const resumed = await runCli(
    ["blog", "resume", requestId, path, "--json"],
    options,
  );
  assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
  const outcome = JSON.parse(resumed.stdout).data;
  assert.equal(outcome.requestId, requestId);
  assert.equal(uploads.length, 4);
  assert.deepEqual(uploads.slice(2), uploads.slice(0, 2));
  const articleUrls = [
    ...outcome.article.content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g),
  ].map((match) => match[1]);
  assert.deepEqual(
    articleUrls,
    previous.map(({ url }) => url),
  );
  const listed = await runCli(["blog", "list", "--json"], options);
  assert.equal(JSON.parse(listed.stdout).data.items.length, 1);
  assert.equal(await readFile(path, "utf8"), source);
  assert.deepEqual(await readFile(join(api.root, "first.png")), PNG);
  assert.deepEqual(await readFile(join(api.root, "second.jpg")), JPEG);
});

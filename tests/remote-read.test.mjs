import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteFixture, runCli } from "./remote-support.mjs";

test("installed CLI requires device authorization before accessing a remote article library", async (t) => {
  const api = await remoteFixture(t);
  const result = await runCli(["blog", "list", "--json"], api.options());
  assert.equal(result.code, 4);
  assert.equal(JSON.parse(result.stdout).error.code, "AUTH_REQUIRED");
});

test("installed CLI lists and reads the same remote article by UUID or complete short ID", async (t) => {
  const api = await remoteFixture(t);
  const token = await api.device();
  const createdResponse = await fetch(`${api.url}/v1/articles`, {
    method: "POST",
    headers: { cookie: api.cookie, "content-type": "application/json" },
    body: JSON.stringify({
      title: "远程文章",
      content: "远程正文",
      description: "说明",
    }),
  });
  assert.equal(createdResponse.status, 201);
  const article = await createdResponse.json();
  const list = await runCli(["blog", "list", "--json"], api.options(token));
  assert.equal(list.code, 0, list.stderr + list.stdout);
  const data = JSON.parse(list.stdout).data;
  assert.equal(data.items[0].id, article.id);
  assert.equal(data.items[0].title, "远程文章");
  assert.equal(data.items[0].status, "draft");
  assert.equal(data.items[0].publishedAt, null);
  for (const id of [article.id, article.shortId]) {
    const shown = await runCli(
      ["blog", "show", id, "--json"],
      api.options(token),
    );
    assert.equal(shown.code, 0, shown.stdout);
    assert.equal(JSON.parse(shown.stdout).data.content, "远程正文");
    assert.equal(
      JSON.parse(shown.stdout).data.revision,
      data.items[0].revision,
    );
  }
});

test("installed CLI paginates after filtering and honors explicit service configuration", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device();
  for (let index = 0; index < 23; index++) {
    const response = await fetch(`${api.url}/v1/articles`, {
      method: "POST",
      headers: { cookie: api.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        title: `${index < 3 ? "目标" : "普通"}文章${index}`,
        content: "正文",
        description: "描述",
      }),
    });
    assert.equal(response.status, 201);
  }
  const options = api.options(token);
  options.env.YOHO_SERVER = "https://wrong.invalid";
  const first = await runCli(
    ["--server", api.url + "/", "blog", "list", "--json"],
    options,
  );
  assert.equal(first.code, 0, first.stdout);
  const page1 = JSON.parse(first.stdout).data;
  assert.equal(page1.items.length, 20);
  assert.equal(page1.nextPage, 2);
  const second = await runCli(
    ["blog", "list", "--server", api.url, "--page", "2", "--json"],
    options,
  );
  const page2 = JSON.parse(second.stdout).data;
  assert.equal(page2.items.length, 3);
  assert.equal(page2.nextPage, null);
  assert.equal(
    new Set([...page1.items, ...page2.items].map((item) => item.id)).size,
    23,
  );
  const filter = await runCli(
    [
      "blog",
      "list",
      "--server",
      api.url,
      "--keyword",
      "目标",
      "--status",
      "draft",
      "--page-size",
      "2",
      "--json",
    ],
    options,
  );
  assert.equal(filter.code, 0, filter.stdout);
  assert.equal(JSON.parse(filter.stdout).data.items.length, 2);
  assert.equal(JSON.parse(filter.stdout).data.nextPage, 2);
  const invalid = await runCli(
    ["blog", "list", "--server", api.url, "--page", "0", "--json"],
    options,
  );
  assert.equal(invalid.code, 2);
  const configured = await runCli(
    ["config", "server", api.url, "--json"],
    options,
  );
  assert.equal(configured.code, 0, configured.stdout);
  delete options.env.YOHO_SERVER;
  const saved = await runCli(["blog", "list", "--json"], options);
  assert.equal(saved.code, 0, saved.stdout);
  const text = await runCli(["blog", "list", "--page-size", "1"], options);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /下一页：2/);
});

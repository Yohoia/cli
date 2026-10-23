import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteFixture, runCli } from "./remote-support.mjs";

test("installed CLI reports invalid article data consistently for publish and resume", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device(),
    options = api.options(token);
  const response = await fetch(`${api.url}/v1/articles`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: api.cookie },
    body: JSON.stringify({
      title: "缺少描述的草稿",
      content: "正文完整，但尚未补充描述。",
      status: "draft",
      format: "md",
      language: "zh",
    }),
  });
  assert.equal(response.status, 201);
  const draft = await response.json();
  const published = await runCli(
    ["blog", "publish", draft.id, "--if-match", draft.revision, "--json"],
    options,
  );
  assert.equal(published.code, 3, published.stdout);
  const failure = JSON.parse(published.stdout).error;
  assert.equal(failure.code, "PUBLISH_FIELDS_REQUIRED");

  const directory = join(
    api.root,
    "config",
    "operations",
    createHash("sha256").update(api.url).digest("hex"),
  );
  const records = await readdir(directory);
  assert.equal(records.length, 1);
  const requestId = records[0].replace(/\.json$/, "");
  const resumed = await runCli(
    ["blog", "resume", requestId, "--json"],
    options,
  );
  assert.equal(resumed.code, 3, resumed.stdout);
  assert.equal(JSON.parse(resumed.stdout).error.code, failure.code);

  const shown = await runCli(["blog", "show", draft.id, "--json"], options);
  assert.equal(shown.code, 0, shown.stdout);
  const article = JSON.parse(shown.stdout).data;
  assert.equal(article.status, "draft");
  assert.equal(article.revision, draft.revision);
});

test("installed CLI distinguishes remote article, argument, authorization and I/O failures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "yoho-remote-errors-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let current;
  const server = createServer((_request, response) => {
    response.writeHead(current.status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: current.error }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(
    () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      }),
  );
  const options = {
    cwd: root,
    env: {
      YOHO_SERVER: `http://127.0.0.1:${server.address().port}`,
      YOHO_TOKEN: "isolated-error-test-token",
      YOHO_CONFIG_DIR: join(root, "config"),
    },
  };
  for (const scenario of [
    { status: 400, error: "publish_fields_required", exitCode: 3 },
    { status: 400, error: "article_fields_required", exitCode: 3 },
    { status: 400, error: "asset_not_ready", exitCode: 3 },
    { status: 400, error: "invalid_pagination_or_status", exitCode: 2 },
    { status: 428, error: "revision_required", exitCode: 2 },
    { status: 409, error: "revision_conflict", exitCode: 3 },
    { status: 401, error: "unauthorized", exitCode: 4 },
    { status: 403, error: "forbidden", exitCode: 4 },
    { status: 503, error: "database_not_configured", exitCode: 5 },
  ]) {
    await t.test(scenario.error, async () => {
      current = scenario;
      const result = await runCli(["blog", "list", "--json"], options);
      assert.equal(result.code, scenario.exitCode, result.stdout);
      assert.equal(
        JSON.parse(result.stdout).error.code,
        scenario.error.toUpperCase(),
      );
    });
  }
});

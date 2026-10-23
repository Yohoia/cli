import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { interceptingProxy } from "./intercepting-proxy.mjs";
import {
  remoteFixture,
  runCli,
  startCli,
  forwardingProxy,
} from "./remote-support.mjs";

test("installed CLI recovers a committed write after a lost HTTP response and never blindly duplicates it", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device();
  let dropQueries = false;
  const proxy = await forwardingProxy(
    t,
    api.url,
    (req) =>
      (req.method === "POST" && req.url === "/v1/cli/articles") ||
      (dropQueries && req.url.startsWith("/v1/cli/operations/")),
  );
  const server = proxy.url;
  const options = api.options(token);
  options.env.YOHO_SERVER = server;
  const path = join(api.root, "draft.md");
  await writeFile(path, "# 恢复上传\n\n正文说明。");
  const recovered = await runCli(["blog", "create", path, "--json"], options);
  assert.equal(recovered.code, 0, recovered.stdout);
  assert.equal(JSON.parse(recovered.stdout).data.article.title, "恢复上传");
  dropQueries = true;
  const unknown = await runCli(["blog", "create", path, "--json"], options);
  assert.equal(unknown.code, 5, unknown.stdout);
  const failure = JSON.parse(unknown.stdout).error;
  assert.equal(failure.code, "RESULT_UNKNOWN");
  const id = failure.message.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)[0];
  dropQueries = false;
  const resumed = await runCli(["blog", "resume", id, path, "--json"], options);
  assert.equal(resumed.code, 0, resumed.stdout);
  const list = await runCli(["blog", "list", "--json"], options);
  assert.equal(JSON.parse(list.stdout).data.items.length, 2);
  const directories = await readdir(join(api.root, "config", "operations"));
  for (const directory of directories)
    for (const file of await readdir(
      join(api.root, "config", "operations", directory),
    )) {
      const raw = await readFile(
        join(api.root, "config", "operations", directory, file),
        "utf8",
      );
      assert.equal(raw.includes(token), false);
      assert.equal(raw.includes("正文说明"), false);
    }
});

test("installed CLI refuses an expired unknown operation number instead of treating it as a new create", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device(),
    options = api.options(token);
  const { mkdir } = await import("node:fs/promises");
  const { createHash, randomUUID } = await import("node:crypto");
  const id = randomUUID();
  const directory = join(
    api.root,
    "config",
    "operations",
    createHash("sha256").update(api.url).digest("hex"),
  );
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${id}.json`),
    JSON.stringify({
      requestId: id,
      server: api.url,
      createdAt: "2020-01-01T00:00:00.000Z",
      kind: "create",
      fingerprint: "old-fingerprint",
    }),
  );
  const path = join(api.root, "draft.md");
  await writeFile(path, "# 旧操作\n\n正文");
  const resumed = await runCli(["blog", "resume", id, path, "--json"], options);
  assert.equal(resumed.code, 5, resumed.stdout);
  assert.equal(JSON.parse(resumed.stdout).error.code, "OPERATION_EXPIRED");
  const list = await runCli(["blog", "list", "--json"], options);
  assert.equal(JSON.parse(list.stdout).data.items.length, 0);
});

test("installed CLI recovers publish and delete responses and replays the original deletion", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device();
  let loseDeleteQueries = true;
  const proxy = await forwardingProxy(
    t,
    api.url,
    (request) =>
      (request.method === "POST" && request.url.endsWith("/publish")) ||
      request.method === "DELETE" ||
      (loseDeleteQueries && request.url.startsWith("/v1/cli/operations/")),
  );
  const options = api.options(token);
  options.env.YOHO_SERVER = proxy.url;
  const path = join(api.root, "conditional.md");
  await writeFile(path, "# 条件写入恢复\n\n正文说明。");
  const created = await runCli(["blog", "create", path, "--json"], options);
  assert.equal(created.code, 0, created.stdout);
  const draft = JSON.parse(created.stdout).data.article;
  loseDeleteQueries = false;
  const published = await runCli(
    ["blog", "publish", draft.id, "--if-match", draft.revision, "--json"],
    options,
  );
  assert.equal(published.code, 0, published.stdout);
  const article = JSON.parse(published.stdout).data.article;
  assert.equal(article.status, "published");
  loseDeleteQueries = true;
  const deleted = await runCli(
    [
      "blog",
      "delete",
      article.id,
      "--yes",
      "--if-match",
      article.revision,
      "--json",
    ],
    options,
  );
  assert.equal(deleted.code, 5, deleted.stdout);
  const failure = JSON.parse(deleted.stdout).error;
  assert.equal(failure.code, "RESULT_UNKNOWN");
  const requestId = failure.message.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)[0];
  loseDeleteQueries = false;
  const resumed = await runCli(
    ["blog", "resume", requestId, "--json"],
    options,
  );
  assert.equal(resumed.code, 0, resumed.stdout);
  const replay = await fetch(`${api.url}/v1/cli/articles/${article.id}`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${token}`,
      "x-request-id": requestId,
      "if-match": article.revision,
    },
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(
    (await replay.json()).result.article,
    JSON.parse(resumed.stdout).data.article,
  );
  assert.equal(
    proxy.requests.filter((request) => request.method === "DELETE").length,
    1,
  );
  const hidden = await runCli(["blog", "show", article.id, "--json"], options);
  assert.equal(hidden.code, 3, hidden.stdout);
  assert.equal(JSON.parse(hidden.stdout).error.code, "ARTICLE_NOT_FOUND");
});

test("cancelling after the server commits preserves the request number and can recover the article", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device();
  let running;
  let dropping = true;
  const proxy = await forwardingProxy(t, api.url, (request) => {
    if (
      dropping &&
      request.method === "POST" &&
      request.url === "/v1/cli/articles"
    ) {
      running.child.kill("SIGINT");
      return true;
    }
    return dropping && request.url.startsWith("/v1/cli/operations/");
  });
  const options = api.options(token);
  options.env.YOHO_SERVER = proxy.url;
  const path = join(api.root, "cancelled.md");
  await writeFile(path, "# 中断恢复\n\n服务器可能已提交。");
  running = await startCli(["blog", "create", path, "--json"], options);
  const cancelled = await running.result;
  assert.equal(cancelled.code, 130, cancelled.stdout + cancelled.stderr);
  const failure = JSON.parse(cancelled.stdout).error;
  assert.equal(failure.code, "RESULT_UNKNOWN");
  assert.match(failure.message, /服务器可能已提交/);
  const requestId = failure.message.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)[0];
  dropping = false;
  const recovered = await runCli(
    ["blog", "resume", requestId, path, "--json"],
    options,
  );
  assert.equal(recovered.code, 0, recovered.stdout);
  const list = await runCli(["blog", "list", "--json"], options);
  assert.equal(JSON.parse(list.stdout).data.items.length, 1);
  assert.equal(
    proxy.requests.filter(
      (request) =>
        request.method === "POST" && request.url === "/v1/cli/articles",
    ).length,
    1,
  );
});

test("a malformed remote response reports a service protocol error instead of blaming CLI arguments", async (t) => {
  const api = await remoteFixture(t);
  const broken = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ items: "incompatible-server-response" }));
  });
  await new Promise((done) => broken.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => broken.close(done)));
  const options = api.options("isolated-test-token");
  options.env.YOHO_SERVER = `http://127.0.0.1:${broken.address().port}`;
  const result = await runCli(["blog", "list", "--json"], options);
  assert.equal(result.code, 5, result.stdout);
  const error = JSON.parse(result.stdout).error;
  assert.equal(error.code, "REMOTE_PROTOCOL_ERROR");
  assert.match(error.message, /CLI.*PageHush.*版本/);
});

test("unconfirmed write recovery retains the original request number through protocol, service and authorization failures", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device();
  let malformed = true;
  let queryStatus = 200;
  const proxy = await interceptingProxy(t, api.url, async (entry, request) => {
    if (!malformed) return;
    if (entry.url.startsWith("/v1/cli/operations/"))
      return {
        status: queryStatus,
        body:
          queryStatus === 200
            ? {}
            : {
                error:
                  queryStatus === 401 ? "unauthorized" : "service_unavailable",
              },
      };
    if (entry.method === "POST" && entry.url === "/v1/cli/articles") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const upstream = await fetch(`${api.url}${entry.url}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-request-id": request.headers["x-request-id"],
        },
        body: Buffer.concat(chunks),
      });
      assert.equal(upstream.status, 201);
      await upstream.arrayBuffer();
      return { status: 200, body: {} };
    }
  });
  const options = api.options(token);
  options.env.YOHO_SERVER = proxy.url;
  const path = join(api.root, "protocol-recovery.md");
  await writeFile(path, "# 协议异常恢复\n\n正文说明。");
  for (const status of [200, 503, 401]) {
    queryStatus = status;
    malformed = true;
    const result = await runCli(["blog", "create", path, "--json"], options);
    assert.equal(result.code, 5, result.stdout);
    const error = JSON.parse(result.stdout).error;
    assert.equal(error.code, "RESULT_UNKNOWN");
    const id = error.message.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)[0];
    malformed = false;
    const resumed = await runCli(
      ["blog", "resume", id, path, "--json"],
      options,
    );
    assert.equal(resumed.code, 0, resumed.stdout);
  }
  const list = await runCli(["blog", "list", "--json"], options);
  assert.equal(JSON.parse(list.stdout).data.items.length, 3);
  assert.equal(
    proxy.requests.filter(
      ({ method, url }) => method === "POST" && url === "/v1/cli/articles",
    ).length,
    3,
  );
});

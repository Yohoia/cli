import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { remoteFixture, runCli, forwardingProxy } from "./remote-support.mjs";

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

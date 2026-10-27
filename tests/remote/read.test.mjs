import { test } from "node:test";
import {
  resolveTestBackend,
  backendManifest,
} from "../helpers/pagehush-runtime.mjs";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { remoteFixture, runCli } from "../helpers/remote-support.mjs";
import { interceptingProxy } from "../helpers/intercepting-proxy.mjs";
const execute = promisify(execFile);

test("installed CLI requires device authorization before accessing a remote article library", async (t) => {
  const api = await remoteFixture(t);
  const options = api.options();
  let keychain;
  if (process.platform === "darwin") {
    keychain = join(api.root, "empty-unlocked.keychain-db");
    const password = randomUUID();
    await execute("/usr/bin/security", [
      "create-keychain",
      "-p",
      password,
      keychain,
    ]);
    await execute("/usr/bin/security", [
      "unlock-keychain",
      "-p",
      password,
      keychain,
    ]);
    options.env.YOHO_KEYCHAIN = keychain;
  }
  try {
    const result = await runCli(["blog", "list", "--json"], options);
    assert.equal(result.code, 4);
    assert.equal(JSON.parse(result.stdout).error.code, "AUTH_REQUIRED");
  } finally {
    if (keychain)
      await execute("/usr/bin/security", ["delete-keychain", keychain]);
  }
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

test("installed CLI retries transient HTTP read failures but stops after three attempts", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device();
  let failures = 2;
  const proxy = await interceptingProxy(t, api.url, (request) => {
    if (request.url.startsWith("/v1/cli/articles") && failures-- > 0)
      return {
        status: 503,
        body: {
          error: "temporarily_unavailable",
          message: "temporary test failure",
        },
      };
  });
  const options = api.options(token);
  options.env.YOHO_SERVER = proxy.url;
  const recovered = await runCli(["blog", "list", "--json"], options);
  assert.equal(recovered.code, 0, recovered.stdout + recovered.stderr);
  assert.deepEqual(JSON.parse(recovered.stdout).data.items, []);
  assert.equal(proxy.requests.length, 3);
  failures = Infinity;
  const failed = await runCli(["blog", "list", "--json"], options);
  assert.equal(failed.code, 5, failed.stdout + failed.stderr);
  assert.equal(JSON.parse(failed.stdout).error.code, "TEMPORARILY_UNAVAILABLE");
  assert.equal(
    proxy.requests.length,
    6,
    "persistent failures must stop after three reads",
  );
});

test("installed CLI reads newest records first and pages equal timestamps by descending stable ID", async (t) => {
  const source = await resolveTestBackend();
  const root = await mkdtemp(join(tmpdir(), "yoho-ordered-read-"));
  const child = spawn(
    process.execPath,
    [
      "--import",
      join(source, backendManifest.loader),
      resolve("tests/helpers/ordered-library-fixture.mjs"),
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        NODE_ENV: "test",
        PAGEHUSH_SOURCE: source,
        PAGEHUSH_API_LOG_LEVEL: "silent",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(async () => {
    if (child.exitCode === null) {
      const closed = new Promise((done) => child.once("close", done));
      child.kill("SIGTERM");
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  });
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  const fixture = await new Promise((ready, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error(`Ordering API failed to start: ${diagnostics}`)),
      20_000,
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Ordering API exited ${code}: ${diagnostics}`));
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output
        .split("\n")
        .find((value) => value.startsWith('{"url"'));
      if (line) {
        clearTimeout(timeout);
        ready(JSON.parse(line));
      }
    });
  });
  const options = {
    cwd: root,
    env: {
      YOHO_SERVER: fixture.url,
      YOHO_TOKEN: fixture.token,
      YOHO_CONFIG_DIR: join(root, "config"),
    },
  };
  const ids = [];
  for (let page = 1; page <= 3; page++) {
    const result = await runCli(
      ["blog", "list", "--page-size", "1", "--page", String(page), "--json"],
      options,
    );
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const data = JSON.parse(result.stdout).data;
    assert.equal(data.items.length, 1);
    ids.push(data.items[0].id);
    assert.equal(data.nextPage, page === 3 ? null : page + 1);
  }
  assert.deepEqual(ids, [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000003",
    "00000000-0000-4000-8000-000000000002",
  ]);
  const reread = await runCli(["blog", "list", "--json"], options);
  assert.equal(reread.code, 0, reread.stdout + reread.stderr);
  assert.deepEqual(
    JSON.parse(reread.stdout).data.items.map((article) => article.id),
    ids,
  );
});

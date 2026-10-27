import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { remoteFixture, runCli } from "../helpers/remote-support.mjs";

test("installed CLI publishes with a version, previews deletion, then soft-deletes with confirmation", async (t) => {
  const api = await remoteFixture(t),
    token = await api.device(),
    options = api.options(token);
  const path = join(api.root, "draft.md");
  await writeFile(path, "# 待发布\n\n正文与描述。\n");
  const created = JSON.parse(
    (await runCli(["blog", "create", path, "--json"], options)).stdout,
  ).data.article;
  const missing = await runCli(
    ["blog", "publish", created.id, "--json"],
    options,
  );
  assert.equal(missing.code, 2);
  const published = await runCli(
    ["blog", "publish", created.id, "--if-match", created.revision, "--json"],
    options,
  );
  assert.equal(published.code, 0, published.stdout);
  const current = JSON.parse(published.stdout).data.article;
  assert.equal(current.status, "published");
  assert.ok(current.publishedAt);
  const again = await runCli(
    ["blog", "publish", current.id, "--if-match", current.revision, "--json"],
    options,
  );
  assert.equal(again.code, 0, again.stdout);
  assert.equal(JSON.parse(again.stdout).data.changed, false);
  assert.equal(
    JSON.parse(again.stdout).data.article.revision,
    current.revision,
  );
  const stale = await runCli(
    [
      "blog",
      "delete",
      current.id,
      "--yes",
      "--if-match",
      created.revision,
      "--json",
    ],
    options,
  );
  assert.equal(stale.code, 3, stale.stdout);
  const preview = await runCli(
    ["blog", "delete", current.id, "--dry-run", "--yes", "--json"],
    options,
  );
  assert.equal(preview.code, 0, preview.stdout);
  assert.equal(JSON.parse(preview.stdout).data.deleted, false);
  const removed = await runCli(
    [
      "blog",
      "delete",
      current.id,
      "--yes",
      "--if-match",
      current.revision,
      "--json",
    ],
    options,
  );
  assert.equal(removed.code, 0, removed.stdout);
  const gone = await runCli(["blog", "show", current.id, "--json"], options);
  assert.equal(gone.code, 3);
  assert.equal(JSON.parse(gone.stdout).error.code, "ARTICLE_NOT_FOUND");
});

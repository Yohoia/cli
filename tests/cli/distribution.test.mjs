import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
test("a mismatched release tag is rejected before rebuilding the CLI", async () => {
  const entry = resolve("dist/cli.js");
  const before = await stat(entry);
  await assert.rejects(
    execute(process.execPath, [
      resolve("scripts/package-release.mjs"),
      "v999.0.0",
    ]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(
        error.stderr,
        /Release tag must match package.json version/u,
      );
      return true;
    },
  );
  assert.equal((await stat(entry)).mtimeMs, before.mtimeMs);
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  const valid = await execute(process.execPath, [
    resolve("scripts/package-release.mjs"),
    "--check",
    `v${manifest.version}`,
  ]);
  assert.match(valid.stdout, /Release metadata valid/u);
});

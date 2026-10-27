import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as runtime from "../helpers/pagehush-runtime.mjs";
import {
  backendManifest,
  verifyTestBackend,
} from "../helpers/pagehush-runtime.mjs";
const execute = promisify(execFile);
test("test backends must match the pinned Git revision, clean tree, lockfile and runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "yoho-backend-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execute("git", ["init", "--quiet", root]);
  const git = (...args) =>
    execute("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args]);
  await writeFile(join(root, ".gitignore"), "node_modules/\n");
  await writeFile(join(root, "package-lock.json"), "{}\n");
  await writeFile(join(root, "entry.mjs"), "export {};\n");
  const loader = join(root, backendManifest.loader);
  await mkdir(join(loader, ".."), { recursive: true });
  await writeFile(loader, "export {};\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  const revision = (await git("rev-parse", "HEAD")).stdout.trim();
  const manifest = {
    ...backendManifest,
    revision,
    entry: "entry.mjs",
    artifacts: ["entry.mjs"],
    lockfileSha256: createHash("sha256").update("{}\n").digest("hex"),
  };
  await runtime.recordTestBackendBuild(root, manifest);
  assert.equal(await verifyTestBackend(root, manifest), await realpath(root));
  await assert.rejects(
    verifyTestBackend(root, { ...manifest, revision: "0".repeat(40) }),
    /版本不匹配/,
  );
  await writeFile(join(root, "entry.mjs"), "// modified\n");
  await assert.rejects(verifyTestBackend(root, manifest), /不干净/);
  await writeFile(join(root, "entry.mjs"), "export {};\n");
  await writeFile(join(root, "untracked.txt"), "untracked");
  await assert.rejects(verifyTestBackend(root, manifest), /不干净/);
  await rm(join(root, "untracked.txt"));
  await assert.rejects(
    verifyTestBackend(root, { ...manifest, lockfileSha256: "0".repeat(64) }),
    /锁文件/,
  );
  await rm(loader);
  await assert.rejects(verifyTestBackend(root, manifest), { code: "ENOENT" });
});

test("ignored runtime artifacts require a build receipt and reject stale files, loaders, or build commands", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "yoho-backend-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execute("git", ["-C", root, "-c", "core.hooksPath=/dev/null", ...args]);
  await git("init", "--quiet");
  await writeFile(join(root, ".gitignore"), "node_modules/\ndist/\n");
  await writeFile(join(root, "package-lock.json"), "{}\n");
  await writeFile(join(root, "entry.mjs"), "export {};\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
  const revision = (await git("rev-parse", "HEAD")).stdout.trim();
  await mkdir(join(root, "dist"));
  await mkdir(join(root, "node_modules"));
  await writeFile(
    join(root, "dist/index.mjs"),
    "export { value } from './value.mjs';\n",
  );
  await writeFile(
    join(root, "dist/value.mjs"),
    "export const value = 'current';\n",
  );
  await writeFile(join(root, "node_modules/loader.mjs"), "export {};\n");
  const manifest = {
    ...backendManifest,
    revision,
    entry: "entry.mjs",
    loader: "node_modules/loader.mjs",
    artifacts: ["dist/index.mjs", "dist"],
    lockfileSha256: createHash("sha256").update("{}\n").digest("hex"),
  };
  await assert.rejects(verifyTestBackend(root, manifest), /构建校验/);
  await runtime.recordTestBackendBuild(root, manifest);
  assert.equal(await verifyTestBackend(root, manifest), await realpath(root));
  await writeFile(
    join(root, "dist/value.mjs"),
    "export const value = 'stale';\n",
  );
  assert.equal((await git("status", "--porcelain")).stdout, "");
  await assert.rejects(verifyTestBackend(root, manifest), /构建校验/);
  await writeFile(
    join(root, "dist/value.mjs"),
    "export const value = 'current';\n",
  );
  await writeFile(join(root, "node_modules/loader.mjs"), "// stale loader\n");
  await assert.rejects(verifyTestBackend(root, manifest), /构建校验/);
  await writeFile(join(root, "node_modules/loader.mjs"), "export {};\n");
  await assert.rejects(
    verifyTestBackend(root, { ...manifest, build: ["run", "another-build"] }),
    /构建校验/,
  );
  await writeFile(join(root, "dist/extra.mjs"), "export {};\n");
  await assert.rejects(verifyTestBackend(root, manifest), /构建校验/);
  await rm(join(root, "dist/extra.mjs"));
  assert.equal(await verifyTestBackend(root, manifest), await realpath(root));
});

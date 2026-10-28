import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../helpers/support.mjs";

async function fixture(t, tools = true) {
  const root = await mkdtemp(join(tmpdir(), "yoho-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config");
  const bin = join(root, "bin");
  await mkdir(config);
  await mkdir(bin);
  if (tools)
    for (const [name, text] of [
      ["git", "git version fixture"],
      ["ssh", "OpenSSH_fixture"],
    ]) {
      const path = join(bin, name);
      await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${text}' >&2\n`);
      await chmod(path, 0o755);
    }
  const key = join(root, "private key");
  await writeFile(key, "PRIVATE_KEY_CONTENT_MUST_NOT_APPEAR\n");
  await writeFile(
    join(config, "config.json"),
    '{"server":"https://saved.example"}\n',
  );
  return {
    root,
    config,
    bin,
    key,
    options: {
      cwd: root,
      env: {
        PATH: bin,
        YOHO_CONFIG_DIR: config,
        YOHO_SKILL_SSH_KEY: key,
        YOHO_SERVER: undefined,
        GIT_SSH_COMMAND: undefined,
        YOHO_TOKEN: "DEVICE_TOKEN_MUST_NOT_APPEAR",
      },
    },
  };
}

test("installed doctor reports the local environment without reading credentials or changing configuration", async (t) => {
  const f = await fixture(t);
  const before = await readFile(join(f.config, "config.json"), "utf8");
  const result = await runCli(["doctor", "--json"], f.options);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.data.healthy, true);
  assert.deepEqual(
    report.data.checks.map((check) => check.id),
    ["node", "git", "ssh", "codeup-ssh", "pagehush-server"],
  );
  assert.ok(report.data.checks.every((check) => check.status === "pass"));
  assert.match(report.data.checks.at(-1).detail, /https:\/\/saved\.example/u);
  assert.doesNotMatch(result.stdout, /PRIVATE_KEY_CONTENT|DEVICE_TOKEN/u);
  assert.equal(await readFile(join(f.config, "config.json"), "utf8"), before);
  assert.deepEqual(await readdir(f.config), ["config.json"]);
});

test("doctor preserves all failed checks in one JSON result with exit code 2", async (t) => {
  const f = await fixture(t, false);
  await writeFile(join(f.config, "config.json"), "{broken");
  f.options.env.YOHO_SKILL_SSH_KEY = join(f.root, "missing-key");
  const result = await runCli(["doctor", "--json"], f.options);
  assert.equal(result.code, 2);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.error.code, "ENVIRONMENT_CHECK_FAILED");
  assert.equal(report.data.healthy, false);
  assert.deepEqual(
    report.data.checks
      .filter((check) => check.status === "fail")
      .map((check) => check.id),
    ["git", "ssh", "codeup-ssh", "pagehush-server"],
  );
  assert.equal(
    await readFile(join(f.config, "config.json"), "utf8"),
    "{broken",
  );
  const human = await runCli(["doctor"], f.options);
  assert.equal(human.code, 2);
  assert.equal(human.stdout, "");
  assert.match(human.stderr, /Git/u);
  assert.match(human.stderr, /OpenSSH/u);
  assert.match(human.stderr, /ENVIRONMENT_CHECK_FAILED/u);
});

test("doctor follows server override precedence and never echoes invalid credentials in URLs", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.config, "config.json"), "{broken");
  f.options.env.YOHO_SERVER = "https://user:URL_SECRET@example.com/path";
  const overridden = await runCli(
    ["--server", "https://override.example", "doctor", "--json"],
    f.options,
  );
  assert.equal(overridden.code, 0, overridden.stdout);
  assert.match(
    JSON.parse(overridden.stdout).data.checks.at(-1).detail,
    /override\.example/u,
  );
  const invalid = await runCli(["doctor", "--json"], f.options);
  assert.equal(invalid.code, 2);
  assert.doesNotMatch(invalid.stdout + invalid.stderr, /URL_SECRET/u);
});

test("doctor warns about custom SSH without executing it or reporting it as verified access", async (t) => {
  const f = await fixture(t);
  f.options.env.GIT_SSH_COMMAND =
    "THIS_CUSTOM_COMMAND_MUST_NOT_RUN_OR_BE_PRINTED";
  f.options.env.YOHO_SKILL_SSH_KEY = join(f.root, "unused-key");
  const result = await runCli(["doctor", "--json"], f.options);
  assert.equal(result.code, 0, result.stdout);
  const check = JSON.parse(result.stdout).data.checks.find(
    (item) => item.id === "codeup-ssh",
  );
  assert.equal(check.status, "warn");
  assert.match(check.detail, /未执行/u);
  assert.doesNotMatch(result.stdout, /THIS_CUSTOM_COMMAND/u);
});

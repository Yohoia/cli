import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  writeFile,
  readFile,
  access,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { skillFixture } from "../helpers/skill-support.mjs";
test("private sources use isolated SSH authentication, stale sources remain visible and other sources work", async (t) => {
  const f = await skillFixture(t);
  const source = f.repos.get("69aa892db28d0aba0f5ed47e/yoho-standard-readme");
  source.private = true;
  let data = (await f.command(["list"])).data;
  assert.equal(data.available, 2);
  assert.equal(data.unknown, 1);
  f.options.env.YOHO_TEST_SSH_AUTH = "fixture-ssh-identity";
  data = (await f.command(["list"])).data;
  assert.equal(data.available, 3);
  await f.command(["install", "yoho-standard-readme", "--target", "claude"]);
  assert.ok(
    f.requests.some((x) => x.authorization === "Bearer fixture-ssh-identity"),
  );
  assert.ok(
    !(await readFile(join(f.root, "config/skills.json"), "utf8")).includes(
      "fixture-ssh-identity",
    ),
  );
  source.status = 503;
  data = (await f.command(["list"])).data;
  assert.equal(data.total, 3);
  assert.equal(data.available, 2);
  assert.equal(
    data.items.find((x) => x.name === "yoho-standard-readme").status,
    "unavailable",
  );
  await f.command(["install", "yoho-standard-readme", "--target", "agents"], 5);
  await assert.rejects(
    access(join(f.project, ".agents/skills/yoho-standard-readme")),
  );
});
test("batch write failure removes newly installed targets but preserves preexisting files", async (t) => {
  const f = await skillFixture(t);
  const blocked = join(f.project, ".codex/skills");
  await mkdir(blocked, { recursive: true });
  await writeFile(join(blocked, "existing"), "keep");
  await chmod(blocked, 0o555);
  try {
    await f.command(
      ["install", "speckit", "--target", "claude", "--target", "codex"],
      4,
    );
    await assert.rejects(access(join(f.project, ".claude/skills/speckit")));
    assert.equal(await readFile(join(blocked, "existing"), "utf8"), "keep");
  } finally {
    await chmod(blocked, 0o755);
  }
});
test("ambiguous manual sources and unsafe link targets are not overwritten", async (t) => {
  const f = await skillFixture(t);
  await f.repo("example/other-speckit", "speckit");
  await f.command(["source", "add", "example/other-speckit"]);
  const path = join(f.project, ".agents/skills/speckit");
  await mkdir(path, { recursive: true });
  const original = "---\nname: speckit\ndescription: Manual\n---\nLocal";
  await writeFile(join(path, "SKILL.md"), original);
  let result = await f.command(["update", "--all", "--target", "agents"]);
  assert.equal(result.data.items[0].status, "skipped");
  assert.match(result.data.items[0].message, /不唯一/);
  assert.equal(await readFile(join(path, "SKILL.md"), "utf8"), original);
  await f.command(["source", "remove", "example/other-speckit"]);
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "keep");
  await symlink(outside, join(path, "linked"));
  result = await f.command(["update", "--all", "--target", "agents"], 3);
  assert.equal(result.data.items[0].status, "failed");
  assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "keep");
});
test("bad state is reported instead of reseeding defaults and missing noninteractive arguments do not wait", async (t) => {
  const f = await skillFixture(t);
  await f.command(["source", "list"]);
  await writeFile(join(f.root, "config/skills.json"), "broken");
  const result = await f.command(["list"], 2);
  assert.equal(result.error.code, "SKILL_CONFIG_INVALID");
  await f.command(["install"], 2);
});

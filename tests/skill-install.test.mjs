import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { skillFixture } from "./skill-support.mjs";
test("installed CLI copies complete skills into selected targets, protects existing content and fixes a commit", async (t) => {
  const f = await skillFixture(t);
  let data = (
    await f.command([
      "install",
      "speckit",
      "yoho-retro-poster",
      "--target",
      "claude",
      "--target",
      "codex",
    ])
  ).data;
  assert.equal(data.items.filter((x) => x.status === "installed").length, 4);
  const path = join(f.project, ".claude/skills/speckit/references/example.md");
  assert.equal(await readFile(path, "utf8"), "Reference one\n");
  await writeFile(path, "manual change");
  data = (await f.command(["install", "speckit", "--target", "claude"])).data;
  assert.equal(data.items[0].status, "skipped");
  assert.equal(await readFile(path, "utf8"), "manual change");
  await f.command([
    "install",
    "speckit",
    "--scope",
    "user",
    "--target",
    "agents",
  ]);
  await access(join(f.home, ".agents/skills/speckit/SKILL.md"));
});
test("batch preflight failure leaves no installed targets", async (t) => {
  const f = await skillFixture(t);
  f.repos
    .get("yohoia/yoho-retro-poster")
    .versions.values()
    .next().value.archive = Buffer.from("broken");
  await f.command(
    ["install", "speckit", "yoho-retro-poster", "--target", "claude"],
    3,
  );
  await assert.rejects(access(join(f.project, ".claude/skills/speckit")));
});
test("single install never overwrites an unparseable existing directory", async (t) => {
  const f = await skillFixture(t);
  const path = join(f.project, ".agents/skills/speckit");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "mine"), "original");
  const data = (await f.command(["install", "speckit", "--target", "agents"]))
    .data;
  assert.equal(data.items[0].status, "skipped");
  assert.equal(await readFile(join(path, "mine"), "utf8"), "original");
});

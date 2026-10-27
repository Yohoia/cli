import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { skillFixture } from "../helpers/skill-support.mjs";
import { randomUUID } from "node:crypto";
import { runCli } from "../helpers/support.mjs";

const entry = (version) =>
  `---\nname: speckit\ndescription: Fixture\nversion: ${version}\n---\nBody\n`;
test("list reads the actual installed version instead of the installation record", async (t) => {
  const f = await skillFixture(t);
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "SKILL.md": entry("0.1.0"),
  });
  await f.command(["install", "speckit", "--target", "agents"]);
  await writeFile(
    join(f.project, ".agents/skills/speckit/SKILL.md"),
    entry("9.9.9"),
  );
  const item = (await f.command(["list"])).data.items.find(
    (item) => item.name === "speckit",
  );
  assert.equal(item.targets[0].version, "9.9.9");
});

test("a missing installation with an interrupted backup is not installed and retains recovery diagnostics", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  const root = join(f.project, ".agents/skills");
  const backup = join(root, `.yoho-backup-speckit-${randomUUID()}`);
  await rename(join(root, "speckit"), backup);
  const item = (await f.command(["list"])).data.items.find(
    (item) => item.name === "speckit",
  );
  assert.equal(item.targets[0].installed, false);
  assert.match(item.targets[0].message, /备份|恢复/);
  const human = await runCli(["skill", "list"], f.options);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /not installed/);
  assert.ok(
    human.stdout.replace(/\s/gu, "").includes(backup.replace(/\s/gu, "")),
  );
});

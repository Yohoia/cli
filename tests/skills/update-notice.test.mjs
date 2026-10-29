import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { skillFixture } from "../helpers/skill-support.mjs";
import { runCli } from "../helpers/support.mjs";

const repo = "69aa892db28d0aba0f5ed47e/yoho-speckit";
const entry = (version) => ({
  "SKILL.md": `---\nname: speckit\ndescription: Skill update notice\n${version ? `metadata:\n  version: "${version}"\n` : ""}---\nContent\n`,
});
const speckit = (result) =>
  result.data.items.find((item) => item.name === "speckit");

test("update notices compare release precedence and preserve every installed version", async (t) => {
  const f = await skillFixture(t);
  await f.repo(repo, "speckit", entry("1.9.0"));
  await f.command(["install", "speckit", "--target", "agents"]);
  await f.repo(repo, "speckit", entry("v1.10.0"));
  await f.command([
    "install",
    "speckit",
    "--scope",
    "user",
    "--target",
    "codex",
  ]);
  const before = await readFile(
    join(f.project, ".agents/skills/speckit/SKILL.md"),
    "utf8",
  );
  const listed = speckit(await f.command(["list"]));
  assert.equal(listed.targets.length, 2);
  assert.deepEqual(
    listed.targets
      .map((target) => [target.version, target.updateStatus])
      .sort(),
    [
      ["1.9.0", "available"],
      ["v1.10.0", "current"],
    ],
  );
  assert.equal(
    await readFile(join(f.project, ".agents/skills/speckit/SKILL.md"), "utf8"),
    before,
  );
  const scoped = speckit(
    await f.command(["list", "--scope", "user", "--target", "codex"]),
  );
  assert.equal(scoped.targets[0].updateStatus, "current");
  await f.command(["update", "speckit"]);
  assert.ok(
    speckit(await f.command(["list"])).targets.every(
      (target) => target.updateStatus === "current",
    ),
  );

  for (const [remote, expected] of [
    ["1.10.0+build.2", "current"],
    ["1.10.0-rc.2", "current"],
    ["1.9.9", "current"],
    ["2.0.0-beta.2", "available"],
  ]) {
    await f.repo(repo, "speckit", entry(remote));
    assert.ok(
      speckit(await f.command(["list"])).targets.every(
        (target) => target.updateStatus === expected,
      ),
      remote,
    );
  }
});

test("manual prereleases use numeric prerelease ordering without silently associating or updating", async (t) => {
  const f = await skillFixture(t);
  const path = join(f.project, ".agents/skills/speckit");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), entry("1.0.0-beta.2")["SKILL.md"]);
  for (const [remote, expected] of [
    ["1.0.0-beta.10", "available"],
    ["1.0.0-beta.1", "current"],
    ["1.0.0-beta.01", "unknown"],
    ["1.0.0", "available"],
  ]) {
    await f.repo(repo, "speckit", entry(remote));
    assert.equal(
      speckit(await f.command(["list"])).targets[0].updateStatus,
      expected,
    );
  }
  const state = JSON.parse(
    await readFile(join(f.root, "config/skills.json"), "utf8"),
  );
  assert.equal(state.records.length, 0);
  await f.repo("team/other-speckit", "speckit", entry("2.0.0"));
  await f.command(["source", "add", "team/other-speckit"]);
  assert.equal(
    speckit(await f.command(["list"])).targets[0].updateStatus,
    "unknown",
  );
});

test("versionless installs compare recorded commits; unavailable sources never report cached updates", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  assert.equal(
    speckit(await f.command(["list"])).targets[0].updateStatus,
    "current",
  );
  await f.repo(repo, "speckit", { "references/example.md": "A new release\n" });
  const changed = speckit(await f.command(["list"]));
  assert.equal(changed.targets[0].updateStatus, "available");
  assert.equal(changed.targets[0].updateReason, "commit");
  f.repos.get(repo).status = 503;
  const failed = speckit(await f.command(["list"]));
  assert.equal(failed.status, "unavailable");
  assert.equal(failed.targets[0].updateStatus, "unknown");
  const text = await runCli(["skill", "list"], f.options);
  assert.ok(!text.stdout.includes("个 Skill 有更新"), text.stdout);
  f.repos.get(repo).status = 200;
  await f.command(["update", "speckit"]);
  assert.equal(
    speckit(await f.command(["list"])).targets[0].updateStatus,
    "current",
  );
});

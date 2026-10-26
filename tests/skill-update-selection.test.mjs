import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { skillFixture } from "./skill-support.mjs";

test("explicit updates retain failure exit codes when a registered source is unavailable", async (t) => {
  for (const [status, exitCode] of [
    [503, 5],
    [403, 4],
  ]) {
    const f = await skillFixture(t);
    await f.command(["install", "speckit", "--target", "agents"]);
    const config = join(f.root, "config/skills.json");
    const records = JSON.parse(await readFile(config, "utf8")).records;
    f.repos.get("yohoia/yoho-speckit").status = status;
    const out = await f.command(
      ["update", "speckit", "--target", "agents"],
      exitCode,
    );
    assert.equal(out.ok, false);
    assert.equal(out.data.items[0].status, "failed");
    assert.equal(
      await readFile(
        join(f.project, ".agents/skills/speckit/references/example.md"),
        "utf8",
      ),
      "Reference one\n",
    );
    assert.deepEqual(
      JSON.parse(await readFile(config, "utf8")).records,
      records,
    );
  }
});

test("manual installations never acquire a source merely from a matching repository slug", async (t) => {
  const f = await skillFixture(t);
  await f.command(["source", "remove", "yohoia/yoho-speckit"]);
  const other = await f.repo("example/speckit", "different-skill");
  other.status = 503;
  await f.command(["source", "add", "example/speckit"]);
  const path = join(f.project, ".agents/skills/speckit");
  const original = "---\nname: speckit\ndescription: Manual\n---\nLocal\n";
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), original);
  const result = await f.command(["update", "--all", "--target", "agents"]);
  assert.deepEqual(result.data.items, []);
  assert.equal(await readFile(join(path, "SKILL.md"), "utf8"), original);
  assert.deepEqual(
    JSON.parse(await readFile(join(f.root, "config/skills.json"), "utf8"))
      .records,
    [],
  );
});

test("an unavailable interactive source cannot recover into an unselected update", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  const config = join(f.root, "config/skills.json");
  const records = JSON.parse(await readFile(config, "utf8")).records;
  const repo = await f.repo("yohoia/yoho-speckit", "speckit", {
    "references/example.md": "Remote update\n",
  });
  repo.status = 503;
  repo.onResponse = (status) => {
    if (status === 503) repo.status = 200;
  };
  const out = await f.terminal(
    ["update", "--scope", "project", "--target", "agents"],
    [],
  );
  assert.equal(out.code, 5, out.terminal + out.stdout);
  assert.match(JSON.parse(out.stdout).data.items[0].message, /来源暂不可用/);
  assert.equal(JSON.parse(out.stdout).data.items[0].status, "failed");
  assert.equal(
    await readFile(
      join(f.project, ".agents/skills/speckit/references/example.md"),
      "utf8",
    ),
    "Reference one\n",
  );
  assert.deepEqual(JSON.parse(await readFile(config, "utf8")).records, records);
});

test("interactive updates explain changed Skill identities without renaming or reassociating", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  await f.repo("yohoia/yoho-speckit", "renamed-speckit");
  const result = await f.terminal(
    ["update", "--scope", "project", "--target", "agents"],
    [],
  );
  assert.equal(result.code, 3, result.terminal + result.stdout);
  assert.match(
    JSON.parse(result.stdout).data.items[0].message,
    /名称已从 speckit 改为 renamed-speckit/,
  );
  assert.equal(JSON.parse(result.stdout).data.items[0].status, "failed");
  const records = JSON.parse(
    await readFile(join(f.root, "config/skills.json"), "utf8"),
  ).records;
  assert.equal(records[0].name, "speckit");
  assert.match(
    await readFile(join(f.project, ".agents/skills/speckit/SKILL.md"), "utf8"),
    /name: speckit/,
  );
});

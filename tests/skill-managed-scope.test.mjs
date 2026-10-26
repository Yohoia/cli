import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { skillFixture } from "./skill-support.mjs";

async function unrelatedSkill(f) {
  const path = join(f.project, ".agents/skills/third-party-helper");
  const original =
    "---\nname: third-party-helper\ndescription: Not managed here\n---\nKeep my content\n";
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), original);
  return { path, original };
}

test("update menus and update-all operate only on registered or previously managed skills", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  const foreign = await unrelatedSkill(f);
  await f.repo("yohoia/yoho-speckit", "speckit", {
    "references/example.md": "Available update\n",
  });
  const menu = await f.terminal(
    ["update", "--scope", "project", "--target", "agents"],
    [{ wait: "选择更新 Skill", keys: "\u0003" }],
  );
  assert.equal(menu.code, 130, menu.stdout + menu.terminal);
  assert.ok(!menu.terminal.includes("third-party-helper"), menu.terminal);
  assert.match(menu.terminal, /可选 1 项/);
  await f.repo("yohoia/yoho-speckit", "speckit", {
    "references/example.md": "New managed content\n",
  });
  const result = await f.command(["update", "--all", "--target", "agents"]);
  assert.equal(result.data.total, 1);
  assert.equal(result.data.items[0].name, "speckit");
  assert.equal(result.data.items[0].status, "updated");
  assert.equal(
    await readFile(join(foreign.path, "SKILL.md"), "utf8"),
    foreign.original,
  );
  const records = JSON.parse(
    await readFile(join(f.root, "config/skills.json"), "utf8"),
  ).records;
  assert.equal(records.length, 1);
  assert.equal(records[0].name, "speckit");
  const explicit = await f.command(
    ["update", "third-party-helper", "--target", "agents"],
    3,
  );
  assert.equal(explicit.error.code, "SKILL_NOT_INSTALLED");
});

test("a directory containing only unrelated skills is an empty managed update scope", async (t) => {
  const f = await skillFixture(t);
  const foreign = await unrelatedSkill(f);
  const menu = await f.terminal(
    ["update", "--scope", "project", "--target", "agents"],
    [],
  );
  assert.equal(menu.code, 0, menu.stdout + menu.terminal);
  assert.ok(!menu.terminal.includes("third-party-helper"), menu.terminal);
  assert.deepEqual(JSON.parse(menu.stdout).data.items, []);
  const all = await f.command(["update", "--all", "--target", "agents"]);
  assert.deepEqual(all.data.items, []);
  assert.equal(
    await readFile(join(foreign.path, "SKILL.md"), "utf8"),
    foreign.original,
  );
});

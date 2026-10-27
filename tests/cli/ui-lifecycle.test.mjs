import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { skillFixture } from "../helpers/skill-support.mjs";

test("Clack installation releases the terminal before Ink renders human results", async (t) => {
  const f = await skillFixture(t);
  const result = await f.terminal(
    ["install"],
    [
      { wait: "安装范围", keys: "\r" },
      { wait: "目标工具", keys: " \r" },
      { wait: "选择安装 Skill", keys: " \r" },
    ],
    { columns: 80, rows: 30 },
    false,
  );
  assert.equal(result.code, 0, result.terminal);
  assert.deepEqual(result.pending, []);
  assert.equal(result.stdout, "");
  const text = stripVTControlCharacters(result.terminal);
  assert.match(text, /Skill 安装结果/);
  assert.match(text, /Skill\s+Source\s+Status\s+Version/);
  assert.match(text, /yoho-standard-readme/);
  assert.ok(
    result.terminal.lastIndexOf("\u001b[?25h") <
      result.terminal.indexOf("Skill 安装结果"),
  );
  assert.match(
    await readFile(
      join(f.project, ".claude/skills/yoho-standard-readme/SKILL.md"),
      "utf8",
    ),
    /name: yoho-standard-readme/,
  );
});

test("cancelling Clack update progress keeps installed files and releases the operation lock", async (t) => {
  const f = await skillFixture(t);
  await f.command([
    "install",
    "speckit",
    "--target",
    "agents",
    "--target",
    "codex",
  ]);
  const path = join(f.project, ".agents/skills/speckit/references/example.md");
  const previous = await readFile(path, "utf8");
  const repo = await f.repo(
    "69aa892db28d0aba0f5ed47e/yoho-speckit",
    "speckit",
    {
      "references/example.md": "Updated reference\n",
    },
  );
  repo.delay = 1000;
  const result = await f.terminal(
    ["update", "speckit"],
    [{ wait: "0/2", keys: "\u0003" }],
    { columns: 80, rows: 30 },
    false,
  );
  assert.equal(result.code, 130, result.terminal);
  assert.deepEqual(result.pending, []);
  assert.equal(await readFile(path, "utf8"), previous);
  assert.match(stripVTControlCharacters(result.terminal), /操作已取消/);
  repo.delay = 0;
  await f.command(["update", "speckit"]);
  assert.equal(await readFile(path, "utf8"), "Updated reference\n");
});

test("Clack progress counts actual installation and update locations without polluting JSON", async (t) => {
  const f = await skillFixture(t);
  f.repos.get("69aa892db28d0aba0f5ed47e/yoho-speckit").delay = 120;
  let result = await f.terminal(
    ["install", "speckit", "--target", "agents", "--target", "codex"],
    [],
    { columns: 50, rows: 24 },
  );
  assert.equal(result.code, 0, result.terminal + result.stdout);
  assert.equal(JSON.parse(result.stdout).data.items.length, 2);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.match(stripVTControlCharacters(result.terminal), /0\/2/);
  assert.match(stripVTControlCharacters(result.terminal), /已处理 2\/2 个位置/);
  assert.match(result.terminal, /█{8,}/u);
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "references/example.md": "Both updated\n",
  });
  result = await f.terminal(["update", "speckit"], [], {
    columns: 80,
    rows: 24,
  });
  assert.equal(result.code, 0, result.terminal + result.stdout);
  assert.equal(
    JSON.parse(result.stdout).data.items.filter(
      (item) => item.status === "updated",
    ).length,
    2,
  );
  assert.match(stripVTControlCharacters(result.terminal), /0\/2/);
  assert.match(stripVTControlCharacters(result.terminal), /已处理 2\/2 个位置/);
});

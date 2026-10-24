import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { access } from "node:fs/promises";
import { skillFixture } from "./skill-support.mjs";
test("real terminal selects multiple targets and skills, then updates through the same installed command", async (t) => {
  const f = await skillFixture(t);
  let result = await f.terminal(
    ["install"],
    [
      { wait: "安装范围", keys: "\r" },
      { wait: "目标工具", keys: " \u001b[B \r" },
      { wait: "选择安装 Skill", keys: "\u001b[B \u001b[B \r" },
    ],
  );
  assert.equal(result.code, 0, result.terminal + result.stdout);
  assert.equal(
    JSON.parse(result.stdout).data.items.filter((x) => x.status === "installed")
      .length,
    4,
  );
  await access(join(f.project, ".claude/skills/speckit/SKILL.md"));
  await access(join(f.project, ".agents/skills/yoho-retro-poster/SKILL.md"));
  result = await f.terminal(
    ["install", "--scope", "project", "--target", "claude"],
    [{ wait: "选择安装 Skill", keys: " \r" }],
  );
  assert.equal(result.code, 0, result.terminal + result.stdout);
  assert.match(result.terminal, /✓ 已安装/);
  await f.repo("yohoia/yoho-speckit", "speckit", {
    "references/example.md": "New",
  });
  result = await f.terminal(
    ["update", "--scope", "project", "--target", "agents"],
    [{ wait: "选择更新 Skill", keys: "a\r" }],
  );
  assert.equal(result.code, 0, result.terminal + result.stdout);
  assert.ok(
    JSON.parse(result.stdout).data.items.some(
      (x) => x.name === "speckit" && x.status === "updated",
    ),
  );
  result = await f.terminal(
    ["update", "--scope", "project", "--target", "agents"],
    [{ wait: "选择更新 Skill", keys: "\u0003" }],
  );
  assert.equal(result.code, 130, result.terminal + result.stdout);
});
test("terminal update distinguishes recorded sources with the same skill name", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "claude"]);
  await f.repo("example/another", "speckit", {
    "references/example.md": "Other original\n",
  });
  await f.command(["source", "add", "example/another"]);
  await f.command(["install", "example/another", "--target", "agents"]);
  await f.repo("yohoia/yoho-speckit", "speckit", {
    "references/example.md": "Author updated\n",
  });
  await f.repo("example/another", "speckit", {
    "references/example.md": "Other updated\n",
  });
  const result = await f.terminal(
    [
      "update",
      "--scope",
      "project",
      "--target",
      "claude",
      "--target",
      "agents",
    ],
    [{ wait: "选择更新 Skill", keys: " \r" }],
  );
  assert.equal(result.code, 0, result.terminal + result.stdout);
  assert.match(result.terminal, /yohoia\/yoho-speckit/);
  assert.match(result.terminal, /example\/another/);
  const items = JSON.parse(result.stdout).data.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].repo, "yohoia/yoho-speckit");
});

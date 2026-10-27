import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { access, mkdir, writeFile } from "node:fs/promises";
import { skillFixture } from "../helpers/skill-support.mjs";
import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";
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
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
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
    [],
  );
  assert.equal(result.code, 0, result.terminal + result.stdout);
  assert.match(result.terminal, /Skill 均为最新版/);
});
test("terminal update distinguishes recorded sources with the same skill name", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "claude"]);
  await f.repo("example/another", "speckit", {
    "references/example.md": "Other original\n",
  });
  await f.command(["source", "add", "example/another"]);
  await f.command(["install", "example/another", "--target", "agents"]);
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
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
  assert.match(result.terminal, /69aa892db28d0aba0f5ed47e\/yoho-speckit/);
  assert.match(result.terminal, /example\/another/);
  const items = JSON.parse(result.stdout).data.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].repo, "69aa892db28d0aba0f5ed47e/yoho-speckit");
});

test("terminal update explains removed, unavailable, and ambiguous sources separately", async (t) => {
  const removed = await skillFixture(t);
  await removed.command(["install", "speckit", "--target", "agents"]);
  await removed.command([
    "source",
    "remove",
    "69aa892db28d0aba0f5ed47e/yoho-speckit",
  ]);
  let result = await removed.terminal(
    ["update", "--scope", "project", "--target", "agents"],
    [],
  );
  assert.equal(result.code, 0, result.terminal + result.stdout);
  assert.match(result.terminal, /来源已移除/);
  assert.match(result.terminal, /69aa892db28d0aba0f5ed47e\/yoho-speckit/);
  assert.equal(JSON.parse(result.stdout).data.items[0].status, "skipped");

  const unavailable = await skillFixture(t);
  await unavailable.command(["install", "speckit", "--target", "agents"]);
  unavailable.repos.get("69aa892db28d0aba0f5ed47e/yoho-speckit").status = 503;
  result = await unavailable.terminal(
    ["update", "--scope", "project", "--target", "agents"],
    [],
  );
  assert.equal(result.code, 5, result.terminal + result.stdout);
  assert.match(JSON.parse(result.stdout).data.items[0].message, /来源暂不可用/);
  assert.match(
    JSON.parse(result.stdout).data.items[0].message,
    /Codeup Git 读取失败/,
  );
  assert.equal(JSON.parse(result.stdout).data.items[0].status, "failed");

  const ambiguous = await skillFixture(t);
  await ambiguous.repo("example/same-name", "speckit");
  await ambiguous.command(["source", "add", "example/same-name"]);
  const manualPath = join(ambiguous.project, ".agents/skills/speckit");
  await mkdir(manualPath, { recursive: true });
  await writeFile(
    join(manualPath, "SKILL.md"),
    "---\nname: speckit\ndescription: Manual\n---\nLocal\n",
  );
  result = await ambiguous.terminal(
    ["update", "--scope", "project", "--target", "agents"],
    [],
  );
  assert.equal(result.code, 0, result.terminal + result.stdout);
  assert.match(result.terminal, /同名来源不唯一/);
  assert.match(result.terminal, /69aa892db28d0aba0f5ed47e\/yoho-speckit/);
  assert.match(result.terminal, /example\/same-name/);
  assert.equal(JSON.parse(result.stdout).data.items[0].status, "skipped");
});

test("terminal update reports blocked sources outside the selectable updates", async (t) => {
  const f = await skillFixture(t);
  await f.command([
    "install",
    "speckit",
    "yoho-retro-poster",
    "--target",
    "agents",
  ]);
  await f.command([
    "source",
    "remove",
    "69aa892db28d0aba0f5ed47e/yoho-speckit",
  ]);
  await f.repo(
    "69aa892db28d0aba0f5ed47e/yoho-retro-poster",
    "yoho-retro-poster",
    {
      "references/example.md": "Available update\n",
    },
  );
  const result = await f.terminal(
    ["update", "--scope", "project", "--target", "agents"],
    [{ wait: "选择更新 Skill", keys: "\u001b[A\u0003" }],
  );
  assert.equal(result.code, 130, result.terminal + result.stdout);
  assert.match(result.terminal, /来源已移除/);
  assert.match(
    result.terminal,
    /yoho skill source add 69aa892db28d0aba0f5ed47e\/yoho-speckit/,
  );
  assert.match(result.terminal, /可选 1 项/);
  assert.match(result.terminal, /全选\/清空/);
});

test("compact update selection supports toggling, inversion and empty selection in a narrow terminal", async (t) => {
  const f = await skillFixture(t);
  await f.command([
    "install",
    "speckit",
    "yoho-retro-poster",
    "--target",
    "agents",
  ]);
  await f.command([
    "source",
    "remove",
    "69aa892db28d0aba0f5ed47e/yoho-speckit",
  ]);
  await f.repo(
    "69aa892db28d0aba0f5ed47e/yoho-retro-poster",
    "yoho-retro-poster",
    {
      "references/example.md": "Available update\n",
    },
  );
  const result = await f.terminal(
    ["update", "--scope", "project", "--target", "agents"],
    [
      { wait: "选择更新 Skill", keys: "\r" },
      { wait: "至少选择一项", keys: "" },
      { wait: "选择更新 Skill", keys: "a" },
      { wait: "◼", keys: "a" },
      { wait: "◻", keys: "i" },
      { wait: "◼", keys: "\r" },
    ],
    { columns: 50, rows: 18 },
  );
  assert.equal(result.code, 0, result.terminal + result.stdout);
  assert.deepEqual(result.pending, []);
  const items = JSON.parse(result.stdout).data.items;
  assert.equal(items.length, 1);
  assert.equal(items[0].repo, "69aa892db28d0aba0f5ed47e/yoho-retro-poster");
  assert.match(result.terminal, /来源已移除/);
  assert.ok(!result.terminal.includes("[来源已移除]"));
  const menuOutput = result.terminal.slice(
    result.terminal.indexOf("◆"),
    result.terminal.lastIndexOf("\u001b[?25h"),
  );
  for (const line of stripVTControlCharacters(
    menuOutput.replace(/\u001b\[\d+[ABCD]/gu, "\n"),
  )
    .replaceAll("\r", "")
    .split("\n"))
    assert.ok(stringWidth(line) <= 50, line);
  assert.ok(
    result.terminal.lastIndexOf("\u001b[?25h") >
      result.terminal.lastIndexOf("\u001b[?25l"),
  );
});

test("update selection pages through registered skills", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "references/example.md": "Available update\n",
  });
  for (let index = 0; index < 10; index++) {
    const name = `aaa-${index}`;
    await f.repo(`example/${name}`, name);
    await f.command(["source", "add", `example/${name}`]);
    const path = join(f.project, ".agents/skills", name);
    await mkdir(path);
    await writeFile(
      join(path, "SKILL.md"),
      `---\nname: ${name}\ndescription: Manual\n---\nLocal\n`,
    );
  }
  const result = await f.terminal(
    ["update", "--scope", "project", "--target", "agents"],
    [
      { wait: "选择更新 Skill", keys: "\u001b[A" },
      {
        wait: "69aa892db28d0aba0f5ed47e/yoho-speckit",
        keys: "\u0003",
      },
    ],
    { columns: 50, rows: 18 },
  );
  assert.equal(result.code, 130, result.terminal + result.stdout);
  assert.deepEqual(result.pending, []);
  assert.match(result.terminal, /可选 11 项/);
  assert.match(result.terminal, /\.\.\./);
  assert.match(result.terminal, /\[有更新\]/);
});

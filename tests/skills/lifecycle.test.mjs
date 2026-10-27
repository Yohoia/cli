import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, chmod, access } from "node:fs/promises";
import { join } from "node:path";
import { skillFixture } from "../helpers/skill-support.mjs";
test("installed CLI completes source management, terminal installation, adoption, partial update and source recovery", async (t) => {
  const f = await skillFixture(t);
  await f.repo("example/new-skill", "new-skill");
  await f.command(["source", "add", "example/new-skill"]);
  await f.command(["source", "refresh"]);
  assert.equal((await f.command(["list"])).data.total, 4);
  const installed = await f.terminal(
    ["install"],
    [
      { wait: "安装范围", keys: "\r" },
      { wait: "目标工具", keys: " \u001b[B \r" },
      { wait: "选择安装 Skill", keys: "\u001b[B \u001b[B \u001b[B \r" },
    ],
  );
  assert.equal(installed.code, 0, installed.terminal + installed.stdout);
  assert.equal(
    JSON.parse(installed.stdout).data.items.filter(
      (x) => x.status === "installed",
    ).length,
    6,
  );
  const codex = join(f.project, ".codex/skills");
  const manual = join(codex, "speckit");
  await mkdir(manual, { recursive: true });
  const old = "---\nname: speckit\ndescription: Manual\n---\nOriginal\n";
  await writeFile(join(manual, "SKILL.md"), old);
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "references/example.md": "Lifecycle update\n",
  });
  await chmod(codex, 0o555);
  let result;
  try {
    result = await f.terminal(
      [
        "update",
        "--scope",
        "project",
        "--target",
        "claude",
        "--target",
        "codex",
        "--target",
        "agents",
      ],
      [{ wait: "选择更新 Skill", keys: "a\r" }],
    );
    assert.equal(result.code, 4, result.terminal + result.stdout);
    const data = JSON.parse(result.stdout);
    assert.equal(data.ok, false);
    assert.equal(
      data.data.items.filter((x) => x.status === "updated").length,
      2,
    );
    assert.equal(
      data.data.items.filter((x) => x.status === "failed").length,
      1,
    );
    assert.equal(await readFile(join(manual, "SKILL.md"), "utf8"), old);
  } finally {
    await chmod(codex, 0o755);
  }
  await f.command(["update", "--all", "--target", "codex"]);
  assert.equal(
    await readFile(join(manual, "references/example.md"), "utf8"),
    "Lifecycle update\n",
  );
  await f.command([
    "source",
    "remove",
    "69aa892db28d0aba0f5ed47e/yoho-speckit",
  ]);
  assert.equal(
    (await f.command(["update", "--all", "--target", "codex"])).data.items[0]
      .status,
    "skipped",
  );
  await access(join(manual, "SKILL.md"));
  await f.command(["source", "add", "69aa892db28d0aba0f5ed47e/yoho-speckit"]);
  assert.equal(
    (await f.command(["update", "--all", "--target", "codex"])).data.items[0]
      .status,
    "unchanged",
  );
  await f.command(["source", "remove", "example/new-skill"]);
  await access(join(f.project, ".agents/skills/new-skill/SKILL.md"));
  assert.equal((await f.command(["list"])).data.total, 3);
});

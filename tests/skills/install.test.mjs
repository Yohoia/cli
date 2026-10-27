import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  access,
  mkdir,
  chmod,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import { skillFixture } from "../helpers/skill-support.mjs";
import { startCli } from "../helpers/support.mjs";

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
    .get("69aa892db28d0aba0f5ed47e/yoho-retro-poster")
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

test("install menu disables a same-name destination owned by another source", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  const original = await readFile(
    join(f.project, ".agents/skills/speckit/SKILL.md"),
    "utf8",
  );
  await f.repo("example/another", "speckit");
  await f.command(["source", "add", "example/another"]);
  const catalog = await f.command(["list", "--target", "agents"]);
  const collision = catalog.data.items.find(
    (item) => item.repo === "example/another",
  );
  assert.equal(collision.targets[0].installed, false);
  const menu = await f.terminal(
    ["install", "--scope", "project", "--target", "agents"],
    [{ wait: "选择安装 Skill", keys: "a\r" }],
  );
  assert.equal(menu.code, 0, menu.stdout + menu.terminal);
  assert.ok(
    JSON.parse(menu.stdout).data.items.every(
      (item) => item.repo !== "example/another",
    ),
    "occupied Skill must not be selectable through select-all",
  );
  assert.match(menu.terminal, /同名目标目录已存在/);
  assert.equal(
    await readFile(join(f.project, ".agents/skills/speckit/SKILL.md"), "utf8"),
    original,
  );
});

test("batch rollback preserves a target replaced by another process", async (t) => {
  const f = await skillFixture(t);
  await f.repo(
    "69aa892db28d0aba0f5ed47e/yoho-speckit",
    "speckit",
    Object.fromEntries(
      Array.from({ length: 600 }, (_, i) => [`references/file-${i}`, "data"]),
    ),
  );
  const blocked = join(f.project, ".codex/skills");
  await mkdir(blocked, { recursive: true });
  await chmod(blocked, 0o555);
  const pending = await startCli(
    [
      "skill",
      "install",
      "speckit",
      "--target",
      "claude",
      "--target",
      "agents",
      "--target",
      "codex",
      "--json",
    ],
    f.options,
  );
  const path = join(f.project, ".claude/skills/speckit");
  const moved = join(f.root, "original-installed-directory");
  try {
    let installed = false;
    for (let i = 0; i < 600; i++) {
      try {
        await access(path);
        installed = true;
        break;
      } catch {}
      await new Promise((done) => setTimeout(done, 5));
    }
    assert.ok(installed, "first target must be installed before replacement");
    await rename(path, moved);
    await mkdir(path);
    await writeFile(join(path, "another-process.txt"), "keep replacement");
    const out = await pending.result;
    assert.equal(out.code, 5, out.stdout + out.stderr);
    assert.equal(JSON.parse(out.stdout).error.code, "SKILL_ROLLBACK_FAILED");
    assert.ok(JSON.parse(out.stdout).error.message.includes(path));
    assert.equal(
      await readFile(join(path, "another-process.txt"), "utf8"),
      "keep replacement",
    );
    await access(join(moved, "SKILL.md"));
    await assert.rejects(access(join(f.project, ".agents/skills/speckit")));
    const state = JSON.parse(
      await readFile(join(f.root, "config/skills.json"), "utf8"),
    );
    assert.deepEqual(state.records, []);
  } finally {
    pending.child.kill("SIGKILL");
    await pending.result;
    await chmod(blocked, 0o755);
  }
});

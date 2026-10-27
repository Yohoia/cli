import { test } from "node:test";
import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { skillFixture } from "../helpers/skill-support.mjs";
import { runCli } from "../helpers/support.mjs";
const state = async (f) =>
  JSON.parse(await readFile(join(f.root, "config/skills.json"), "utf8"));
const missing = async (path) =>
  assert.rejects(access(path), { code: "ENOENT" });

test("uninstall removes local installations offline, retains the catalog, and allows reinstalling without adding its source", async (t) => {
  const f = await skillFixture(t);
  await f.command([
    "install",
    "speckit",
    "--scope",
    "user",
    "--target",
    "codex",
  ]);
  await f.command(["install", "speckit", "--target", "agents"]);
  const another = join(f.root, "another project");
  await mkdir(another);
  await f.command([
    "install",
    "speckit",
    "--project-path",
    another,
    "--target",
    "claude",
  ]);
  const manual = join(f.project, ".claude/skills/custom-speckit-folder");
  await mkdir(manual, { recursive: true });
  await writeFile(
    join(manual, "SKILL.md"),
    "---\nname: speckit\ndescription: Manual\n---\nKeep until confirmed\n",
  );
  const unrelated = join(f.project, ".agents/skills/third-party");
  await mkdir(unrelated);
  await writeFile(
    join(unrelated, "SKILL.md"),
    "---\nname: third-party\ndescription: Foreign\n---\nKeep\n",
  );
  const original = await state(f);
  const requests = f.requests.length;
  for (const repo of f.repos.values()) repo.status = 503;
  const preview = await f.command([
    "uninstall",
    "speckit",
    "--dry-run",
    "--yes",
  ]);
  assert.equal(preview.data.operation, "uninstall-preview");
  assert.equal(preview.data.items.length, 4);
  assert.deepEqual(await state(f), original);
  for (const item of preview.data.items)
    await access(join(item.path, "SKILL.md"));
  const removed = await f.command(["uninstall", "speckit", "--yes"]);
  assert.equal(removed.data.items.length, 4);
  assert.ok(removed.data.items.every((item) => item.status === "uninstalled"));
  assert.deepEqual(removed.data.removedSources, []);
  for (const item of removed.data.items) await missing(item.path);
  const next = await state(f);
  assert.equal(next.records.length, 0);
  assert.deepEqual(next.sources, original.sources);
  assert.match(await readFile(join(unrelated, "SKILL.md"), "utf8"), /Keep/);
  assert.equal(f.requests.length, requests, "deletion must not access Codeup");
  for (const repo of f.repos.values()) repo.status = 200;
  const listed = (await f.command(["list"])).data.items;
  assert.equal(listed.length, 3);
  assert.ok(
    listed
      .find((item) => item.repo === "69aa892db28d0aba0f5ed47e/yoho-speckit")
      .targets.every((target) => !target.installed),
  );
  const output = await runCli(["skill", "list"], f.options);
  assert.equal(output.code, 0, output.stderr);
  assert.match(output.stdout, /not installed/u);
  assert.match(output.stdout, /Total: 3 · 0 installed · 3 not installed/u);
  await f.command(["install", "speckit", "--target", "agents"]);
  await access(join(f.project, ".agents/skills/speckit/SKILL.md"));
  await f.command([
    "source",
    "remove",
    "69aa892db28d0aba0f5ed47e/yoho-speckit",
  ]);
  assert.ok(
    !(await state(f)).sources.some(
      (source) => source.repo === "69aa892db28d0aba0f5ed47e/yoho-speckit",
    ),
  );
  await access(join(f.project, ".agents/skills/speckit/SKILL.md"));
});

test("uninstall requires confirmation in scripts, rejects conflicting options, and supports remove alias", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  const original = await state(f);
  const noConfirmation = await f.command(["uninstall", "speckit"], 2);
  assert.equal(noConfirmation.error.code, "CONFIRMATION_REQUIRED");
  await f.command(["uninstall"], 2);
  await f.command(["uninstall", "speckit", "--all", "--yes"], 2);
  await f.command(["uninstall", "third-party", "--yes"], 3);
  assert.deepEqual(await state(f), original);
  await access(join(f.project, ".agents/skills/speckit/SKILL.md"));
  await f.command(["remove", "speckit", "--yes"]);
  await missing(join(f.project, ".agents/skills/speckit"));
});

test("uninstall supports terminal multi-selection, defaults confirmation to cancel and retains one JSON result", async (t) => {
  const f = await skillFixture(t);
  await f.command([
    "install",
    "speckit",
    "yoho-retro-poster",
    "--target",
    "agents",
  ]);
  const original = await state(f);
  let result = await f.terminal(
    ["uninstall", "speckit"],
    [{ wait: "确认删除以上文件和安装记录", keys: "\r" }],
  );
  assert.equal(result.code, 130, result.terminal + result.stdout);
  assert.equal(JSON.parse(result.stdout).error.code, "CANCELLED");
  assert.deepEqual(await state(f), original);
  result = await f.terminal(
    ["uninstall"],
    [{ wait: "选择删除 Skill", keys: "\u0003" }],
  );
  assert.equal(result.code, 130, result.terminal + result.stdout);
  assert.deepEqual(await state(f), original);
  result = await f.terminal(
    ["uninstall"],
    [
      { wait: "选择删除 Skill", keys: " \u001b[B \r" },
      { wait: "确认删除以上文件和安装记录", keys: "\u001b[B\r" },
    ],
    { columns: 50, rows: 30 },
  );
  assert.equal(result.code, 0, result.terminal + result.stdout);
  assert.deepEqual(result.pending, []);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  const data = JSON.parse(result.stdout).data;
  assert.equal(data.items.length, 2);
  assert.deepEqual(data.removedSources, []);
  assert.match(result.terminal, /Skill 删除预览/);
  assert.ok(!result.terminal.includes("yoho-standard-readme"), result.terminal);
  await missing(join(f.project, ".agents/skills/speckit"));
  await missing(join(f.project, ".agents/skills/yoho-retro-poster"));
  assert.deepEqual((await state(f)).sources, original.sources);
});

test("a failed target retains its files, record and source while completed targets remain deleted and retry converges", async (t) => {
  const f = await skillFixture(t);
  await f.command([
    "install",
    "speckit",
    "--target",
    "claude",
    "--target",
    "codex",
  ]);
  const blocked = join(f.project, ".codex/skills");
  await chmod(blocked, 0o555);
  try {
    const out = await f.command(["uninstall", "speckit", "--yes"], 4);
    assert.equal(
      out.data.items.filter((item) => item.status === "uninstalled").length,
      1,
    );
    assert.equal(
      out.data.items.filter((item) => item.status === "failed").length,
      1,
    );
    assert.deepEqual(out.data.removedSources, []);
    await missing(join(f.project, ".claude/skills/speckit"));
    await access(join(blocked, "speckit/SKILL.md"));
    const next = await state(f);
    assert.equal(next.records.length, 1);
    assert.equal(next.records[0].path, join(blocked, "speckit"));
    assert.ok(
      next.sources.some(
        (source) => source.repo === "69aa892db28d0aba0f5ed47e/yoho-speckit",
      ),
    );
  } finally {
    await chmod(blocked, 0o755);
  }
  await f.command(["uninstall", "speckit", "--yes"]);
  assert.equal((await state(f)).records.length, 0);
  assert.ok(
    (await state(f)).sources.some(
      (source) => source.repo === "69aa892db28d0aba0f5ed47e/yoho-speckit",
    ),
  );
});

test("uninstall cleans missing records, leaves uninstalled sources alone, and all can be repeated", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  const original = await state(f);
  await rm(join(f.project, ".agents/skills/speckit"), { recursive: true });
  const out = await f.command(["uninstall", "speckit", "--yes"]);
  assert.match(out.data.items[0].message, /清理安装记录/);
  assert.equal((await state(f)).records.length, 0);
  await f.command(["uninstall", "--all", "--yes"]);
  assert.deepEqual((await state(f)).sources, original.sources);
  assert.deepEqual(
    (await f.command(["uninstall", "--all", "--yes"])).data.items,
    [],
  );
  assert.equal((await f.command(["source", "list"])).data.items.length, 3);
});

test("uninstall refuses ambiguous manual copies, but can select a recorded source explicitly", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  await f.repo("example/another", "speckit");
  await f.command(["source", "add", "example/another"]);
  await f.command(["source", "refresh"]);
  await f.command(["uninstall", "speckit", "--yes"], 3);
  const manual = join(f.project, ".claude/skills/manual");
  await mkdir(manual, { recursive: true });
  await writeFile(
    join(manual, "SKILL.md"),
    "---\nname: speckit\ndescription: Unknown origin\n---\nKeep",
  );
  const out = await f.command(
    ["uninstall", "69aa892db28d0aba0f5ed47e/yoho-speckit", "--yes"],
    5,
  );
  assert.ok(
    out.data.items.some(
      (item) => item.path === manual && item.status === "failed",
    ),
  );
  await access(join(manual, "SKILL.md"));
  await missing(join(f.project, ".agents/skills/speckit"));
  assert.ok(
    (await state(f)).sources.some(
      (source) => source.repo === "69aa892db28d0aba0f5ed47e/yoho-speckit",
    ),
  );
});

test("uninstall preserves external symlink content and refuses redirected roots or interrupted backups", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  const path = join(f.project, ".agents/skills/speckit");
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep"), "Do not delete");
  await symlink(outside, join(path, "external"));
  await f.command(["uninstall", "speckit", "--yes"]);
  assert.equal(await readFile(join(outside, "keep"), "utf8"), "Do not delete");
  await f.command(["source", "add", "69aa892db28d0aba0f5ed47e/yoho-speckit"]);
  await f.command(["install", "speckit", "--target", "agents"]);
  const movedRoot = join(f.root, "moved-root");
  await rename(join(f.project, ".agents/skills"), movedRoot);
  await symlink(movedRoot, join(f.project, ".agents/skills"));
  const unsafe = await f.command(["uninstall", "speckit", "--yes"], 5);
  assert.equal(unsafe.error.code, "SKILL_TARGET_UNSAFE");
  await access(join(movedRoot, "speckit/SKILL.md"));
  await rm(join(f.project, ".agents/skills"));
  await rename(movedRoot, join(f.project, ".agents/skills"));
  const held = join(f.root, "held-installation");
  await rename(path, held);
  await symlink(outside, path);
  const linked = await f.command(["uninstall", "speckit", "--yes"], 5);
  assert.equal(linked.data.items[0].status, "failed");
  assert.equal(await readFile(join(outside, "keep"), "utf8"), "Do not delete");
  await rm(path);
  await rename(held, path);
  const backup = join(
    f.project,
    `.agents/skills/.yoho-backup-speckit-${randomUUID()}`,
  );
  await rename(path, backup);
  const recovery = await f.command(["uninstall", "speckit", "--yes"], 5);
  assert.equal(recovery.data.items[0].status, "failed");
  await access(join(backup, "SKILL.md"));
  assert.equal((await state(f)).records.length, 1);
});

test("the uninstall picker selects one installed Skill across its locations and preserves the unselected Skill", async (t) => {
  const f = await skillFixture(t);
  await f.command([
    "install",
    "speckit",
    "--target",
    "agents",
    "--target",
    "codex",
  ]);
  await f.command(["install", "yoho-retro-poster", "--target", "agents"]);
  const foreign = join(f.project, ".agents/skills/foreign-helper");
  await mkdir(foreign);
  await writeFile(
    join(foreign, "SKILL.md"),
    "---\nname: foreign-helper\ndescription: Not managed\n---\nKeep",
  );
  const original = await state(f);
  const requests = f.requests.length;
  const result = await f.terminal(
    ["uninstall"],
    [
      { wait: "选择删除 Skill", keys: "\u001b[B \r" },
      { wait: "确认删除以上文件和安装记录", keys: "\u001b[B\r" },
    ],
  );
  assert.equal(result.code, 0, result.terminal + result.stdout);
  assert.deepEqual(result.pending, []);
  const out = JSON.parse(result.stdout);
  assert.equal(out.data.items.length, 2);
  assert.ok(
    out.data.items.every(
      (item) => item.name === "speckit" && item.status === "uninstalled",
    ),
  );
  assert.match(result.terminal, /2 处安装/);
  assert.ok(!result.terminal.includes("yoho-standard-readme"), result.terminal);
  assert.ok(!result.terminal.includes("foreign-helper"), result.terminal);
  await access(join(f.project, ".agents/skills/yoho-retro-poster/SKILL.md"));
  await access(join(foreign, "SKILL.md"));
  await missing(join(f.project, ".agents/skills/speckit"));
  await missing(join(f.project, ".codex/skills/speckit"));
  assert.deepEqual((await state(f)).sources, original.sources);
  assert.equal((await state(f)).records.length, 1);
  assert.equal(f.requests.length, requests);
});

test("an empty installed catalog reports no installed Skill without opening a picker or changing registrations", async (t) => {
  const f = await skillFixture(t);
  await f.command(["source", "refresh"]);
  const original = await state(f);
  const requests = f.requests.length;
  const result = await f.terminal(
    ["uninstall"],
    [],
    { columns: 50, rows: 24 },
    false,
  );
  assert.equal(result.code, 0, result.terminal);
  assert.deepEqual(result.pending, []);
  assert.match(result.terminal, /没有已安装的受管 Skill/);
  assert.ok(!result.terminal.includes("选择删除 Skill"), result.terminal);
  assert.ok(!result.terminal.includes("确认删除"), result.terminal);
  assert.deepEqual(await state(f), original);
  assert.equal(f.requests.length, requests);
});

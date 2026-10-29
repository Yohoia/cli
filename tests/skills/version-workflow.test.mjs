import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  mkdir,
  chmod,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { skillFixture } from "../helpers/skill-support.mjs";
import { runCli } from "../helpers/support.mjs";

const entry = (version) =>
  `---\nname: speckit\ndescription: Test speckit\nversion: ${version}\n---\nSkill content\n`;

test("nested metadata versions appear for remote and manually installed Skills and survive updates", async (t) => {
  const f = await skillFixture(t);
  const nested = (version) =>
    `---\nname: speckit\ndescription: Test speckit\nmetadata:\n  version: "${version}"\n  author: Yohoia\n---\nSkill content\n`;
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "SKILL.md": nested("0.1.1"),
  });
  const remote = await f.command(["list"]);
  assert.equal(
    remote.data.items.find((item) => item.name === "speckit").version,
    "0.1.1",
  );
  const local = join(f.home, ".codex/skills/speckit");
  await mkdir(local, { recursive: true });
  await writeFile(join(local, "SKILL.md"), nested("0.1.0"));
  const listed = await f.command(["list"]);
  assert.equal(
    listed.data.items.find((item) => item.name === "speckit").targets[0]
      .version,
    "0.1.0",
  );
  const text = await runCli(["skill", "list"], f.options);
  assert.match(text.stdout, /v0\.1\.0/);
  await f.command(["install", "speckit", "--target", "claude"]);
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "SKILL.md": nested("v0.1.2"),
  });
  const updated = await f.command(["update", "speckit"]);
  assert.equal(updated.data.items.length, 2);
  assert.ok(updated.data.items.every((item) => item.version === "v0.1.2"));
  const current = await f.command(["list"]);
  assert.ok(
    current.data.items
      .find((item) => item.name === "speckit")
      .targets.every((target) => target.version === "v0.1.2"),
  );
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "SKILL.md": entry("0.2.0").replace(
      "version: 0.2.0",
      'version: 0.2.0\nmetadata:\n  version: "0.1.9"',
    ),
  });
  const compatible = await f.command(["list"]);
  assert.equal(
    compatible.data.items.find((item) => item.name === "speckit").version,
    "0.2.0",
  );
});

test("skill lists show actual installation state and declared versions", async (t) => {
  const f = await skillFixture(t);
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "SKILL.md": entry("0.1.1"),
  });
  await f.command([
    "install",
    "speckit",
    "--scope",
    "user",
    "--target",
    "codex",
  ]);
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "SKILL.md": entry("0.1.2"),
  });
  const out = await runCli(["skill", "list"], f.options);
  assert.equal(out.code, 0, out.stderr);
  assert.ok(!out.stdout.includes("可安装"), out.stdout);
  assert.ok(!out.stdout.includes("说明"), out.stdout);
  assert.match(out.stdout, /installed/);
  assert.match(out.stdout, /not installed/);
  assert.match(out.stdout, /v0\.1\.1/);
  assert.match(out.stdout, /v0\.1\.1 → v0\.1\.2/);
  assert.match(out.stdout, /↑ 有更新/);
  assert.match(out.stdout, /1 个 Skill 有更新/);
  assert.match(out.stdout, /yoho skill update/);
  assert.match(out.stdout, /Version/);
  assert.match(out.stdout, /Total: 3 · 1 installed · 2 not installed/);
  assert.ok(!out.stdout.includes("Skill 列表"), out.stdout);
  const help = await runCli(["--help"], f.options);
  assert.equal(help.code, 0);
  assert.ok(
    !help.stdout.includes("管理远程博客文章与 GitHub Skill"),
    help.stdout,
  );
});

test("update results contain only Skill, status and version headers and retain partial failures", async (t) => {
  const f = await skillFixture(t);
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "SKILL.md": entry("0.1.1"),
  });
  await f.command([
    "install",
    "speckit",
    "--scope",
    "user",
    "--target",
    "codex",
  ]);
  await f.command(["install", "speckit", "--target", "agents"]);
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "SKILL.md": entry("0.1.2"),
  });
  const blocked = join(f.project, ".agents/skills");
  await chmod(blocked, 0o555);
  try {
    const result = await runCli(["skill", "update", "speckit"], f.options);
    assert.equal(result.code, 4, result.stdout + result.stderr);
    const header = result.stderr
      .split("\n")
      .find((line) => /^\s+Skill\s+Status\s+Version\s*$/.test(line));
    assert.ok(header, result.stderr);
    assert.deepEqual(header.trim().split(/\s+/), [
      "Skill",
      "Status",
      "Version",
    ]);
    assert.match(result.stderr, /已更新/);
    assert.match(result.stderr, /更新失败/);
    assert.match(result.stderr, /v0\.1\.2/);
    assert.match(
      await readFile(join(f.home, ".codex/skills/speckit/SKILL.md"), "utf8"),
      /version: 0\.1\.2/,
    );
    assert.match(
      await readFile(join(blocked, "speckit/SKILL.md"), "utf8"),
      /version: 0\.1\.1/,
    );
  } finally {
    await chmod(blocked, 0o755);
  }
  const afterFailure = await f.command(["list"]);
  const locations = afterFailure.data.items.find(
    (item) => item.name === "speckit",
  ).targets;
  assert.equal(
    locations.find((target) => target.path.startsWith(f.project)).updateStatus,
    "available",
  );
  assert.equal(
    locations.find((target) => target.path.startsWith(f.home)).updateStatus,
    "current",
  );
});

test("automatic updates reject a recorded parent redirected through a symlink", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  const root = join(f.project, ".agents/skills");
  await rename(root, root + "-original");
  const outside = join(f.root, "outside");
  await mkdir(join(outside, "speckit"), { recursive: true });
  await writeFile(join(outside, "speckit/sentinel"), "keep other content");
  await symlink(outside, root);
  const out = await f.command(["update", "--all"], 5);
  assert.equal(out.error.code, "SKILL_TARGET_UNSAFE");
  assert.equal(
    await readFile(join(outside, "speckit/sentinel"), "utf8"),
    "keep other content",
  );
});

test("automatic update offers only changes and updates every recorded location without directory questions", async (t) => {
  const f = await skillFixture(t);
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "SKILL.md": entry("v0.1.1"),
  });
  await f.command([
    "install",
    "speckit",
    "--scope",
    "user",
    "--target",
    "codex",
  ]);
  await f.command(["install", "speckit", "--target", "agents"]);
  const otherProject = join(f.root, "another-project");
  await mkdir(otherProject);
  await f.command([
    "install",
    "speckit",
    "--project-path",
    otherProject,
    "--target",
    "claude",
  ]);
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "SKILL.md": entry("0.1.2"),
  });
  const out = await f.terminal(
    ["update"],
    [{ wait: "选择更新 Skill", keys: "a\r" }],
  );
  assert.equal(out.code, 0, out.terminal + out.stdout);
  assert.deepEqual(out.pending, []);
  assert.ok(!out.terminal.includes("更新范围"), out.terminal);
  assert.ok(!out.terminal.includes("目标工具"), out.terminal);
  const data = JSON.parse(out.stdout).data;
  assert.equal(data.items.length, 3);
  assert.ok(
    data.items.every(
      (item) => item.status === "updated" && item.version === "0.1.2",
    ),
  );
  for (const path of [
    join(f.home, ".codex/skills/speckit"),
    join(f.project, ".agents/skills/speckit"),
    join(otherProject, ".claude/skills/speckit"),
  ])
    assert.match(
      await readFile(join(path, "SKILL.md"), "utf8"),
      /version: 0\.1\.2/,
    );
  const latest = await f.terminal(["update"], []);
  assert.equal(latest.code, 0, latest.terminal + latest.stdout);
  assert.match(latest.terminal, /无可用更新/);
  assert.match(latest.terminal, /Skill 均为最新版/);
  assert.ok(!latest.terminal.includes("选择更新 Skill"), latest.terminal);
  const text = await runCli(["skill", "update", "speckit"], f.options);
  assert.equal(text.code, 0, text.stderr);
  assert.equal(text.stdout.trim().split("\n").length, 1);
  assert.match(text.stdout, /✓ 无可用更新，Skill 均为最新版/);
  assert.ok(!text.stdout.includes("Skill 更新结果"), text.stdout);
});

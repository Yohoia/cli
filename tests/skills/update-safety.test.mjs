import { test } from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { skillFixture } from "../helpers/skill-support.mjs";
import { startCli, runCli } from "../helpers/support.mjs";

test("update refuses a concurrently replaced directory and keeps the foreign content", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  await f.repo(
    "69aa892db28d0aba0f5ed47e/yoho-speckit",
    "speckit",
    Object.fromEntries(
      Array.from({ length: 3000 }, (_, i) => [
        `references/file-${i}`,
        "New content",
      ]),
    ),
  );
  const root = join(f.project, ".agents/skills");
  const path = join(root, "speckit");
  const original = join(f.root, "original-installation");
  const pending = await startCli(
    ["skill", "update", "speckit", "--json"],
    f.options,
  );
  let staged = false;
  for (let i = 0; i < 1000; i++) {
    if ((await readdir(root)).some((name) => name.startsWith(".yoho-stage-"))) {
      staged = true;
      break;
    }
    await new Promise((done) => setTimeout(done, 2));
  }
  assert.ok(staged, "wait for actual staging before replacing the target");
  await rename(path, original);
  await mkdir(path);
  await writeFile(join(path, "foreign-content"), "Keep this replacement");
  const result = await pending.result;
  assert.equal(result.code, 5, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).data.items[0].status, "failed");
  assert.equal(
    await readFile(join(path, "foreign-content"), "utf8"),
    "Keep this replacement",
  );
  await access(join(original, "SKILL.md"));
});

test("a redirected unselected installation does not block another Skill and update-all reports per-target failure", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  const other = join(f.root, "another-project");
  await mkdir(other);
  await f.command([
    "install",
    "yoho-retro-poster",
    "--project-path",
    other,
    "--target",
    "claude",
  ]);
  const root = join(other, ".claude/skills");
  await rename(root, root + "-preserved");
  const outside = join(f.root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "sentinel"), "Do not touch");
  await symlink(outside, root);
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "references/example.md": "New\n",
  });
  let out = await f.command(["update", "speckit"]);
  assert.equal(out.data.items.length, 1);
  assert.equal(out.data.items[0].status, "updated");
  out = await f.command(["update", "--all"], 5);
  assert.ok(
    out.data.items.some(
      (item) => item.name === "yoho-retro-poster" && item.status === "failed",
    ),
  );
  assert.ok(
    out.data.items.some(
      (item) => item.name === "speckit" && item.status === "unchanged",
    ),
  );
  assert.equal(
    await readFile(join(outside, "sentinel"), "utf8"),
    "Do not touch",
  );
});

test("explicit update scopes reject redirected recorded parents without adopting external copies", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  const root = join(f.project, ".agents/skills");
  const original = root + "-preserved";
  await rename(root, original);
  const outside = join(f.root, "external-skills");
  await mkdir(join(outside, "speckit"), { recursive: true });
  await writeFile(
    join(outside, "speckit/SKILL.md"),
    "---\nname: speckit\ndescription: External manual copy\n---\nExternal content\n",
  );
  await writeFile(join(outside, "speckit/sentinel"), "Do not touch");
  await symlink(outside, root);
  const before = await readFile(join(f.root, "config/skills.json"), "utf8");
  for (const flags of [
    ["--target", "agents"],
    ["--scope", "project"],
    ["--project-path", f.project],
  ]) {
    const out = await f.command(["update", "speckit", ...flags], 5);
    assert.equal(out.data.items.length, 1);
    assert.equal(out.data.items[0].status, "failed");
    assert.match(out.data.items[0].message, /父目录.*重定向/);
    assert.equal(
      await readFile(join(outside, "speckit/sentinel"), "utf8"),
      "Do not touch",
    );
    assert.equal(
      await readFile(join(f.root, "config/skills.json"), "utf8"),
      before,
    );
  }
  await access(join(original, "speckit/SKILL.md"));
  const poster = join(outside, "yoho-retro-poster");
  await mkdir(poster);
  await writeFile(
    join(poster, "SKILL.md"),
    "---\nname: yoho-retro-poster\ndescription: External unrelated copy\n---\nExternal content\n",
  );
  await writeFile(
    join(poster, "sentinel"),
    "Do not adopt another skill through the redirected root",
  );
  const unrelated = await f.command(
    ["update", "yoho-retro-poster", "--target", "agents"],
    3,
  );
  assert.equal(unrelated.error.code, "SKILL_NOT_INSTALLED");
  assert.equal(
    await readFile(join(poster, "sentinel"), "utf8"),
    "Do not adopt another skill through the redirected root",
  );
  await f.command(["install", "speckit", "--target", "codex"]);
  const healthy = await f.command(["update", "speckit", "--target", "codex"]);
  assert.equal(healthy.data.items.length, 1);
  assert.equal(healthy.data.items[0].status, "unchanged");
  assert.ok(healthy.data.items[0].path.includes(".codex/"));
  assert.equal(
    await readFile(join(outside, "speckit/sentinel"), "utf8"),
    "Do not touch",
  );
});

test("unrelated unreadable scan roots do not prevent healthy installations from updating or uninstalling", async (t) => {
  for (const broken of ["skills", "parent"]) {
    await t.test(broken, async (t) => {
      const f = await skillFixture(t);
      await f.command(["install", "speckit", "--target", "agents"]);
      const codex = join(f.project, ".codex");
      if (broken === "skills") {
        await mkdir(codex);
        await writeFile(join(codex, "skills"), "Not a directory");
      } else await writeFile(codex, "Not a directory");
      await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
        "references/example.md": "Updated despite another tool's broken root\n",
      });
      const updated = await runCli(
        ["skill", "update", "speckit", "--json"],
        f.options,
      );
      assert.equal(updated.code, 0, updated.stdout + updated.stderr);
      assert.equal(JSON.parse(updated.stdout).data.items[0].status, "updated");
      assert.match(updated.stderr, /无法扫描 Skill 目录/);
      const removed = await runCli(
        ["skill", "uninstall", "speckit", "--yes", "--json"],
        f.options,
      );
      assert.equal(removed.code, 0, removed.stdout + removed.stderr);
      assert.equal(
        JSON.parse(removed.stdout).data.items[0].status,
        "uninstalled",
      );
      assert.match(removed.stderr, /无法扫描 Skill 目录/);
      await assert.rejects(access(join(f.project, ".agents/skills/speckit")), {
        code: "ENOENT",
      });
    });
  }
});

test("a redirected explicit target cannot update another project's recorded copy", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  const other = join(f.root, "other-project");
  await mkdir(other);
  await f.command([
    "install",
    "speckit",
    "--target",
    "agents",
    "--project-path",
    other,
  ]);
  const root = join(f.project, ".agents/skills");
  const outside = join(other, ".agents/skills");
  await writeFile(
    join(outside, "speckit/sentinel"),
    "Preserve the other project",
  );
  await rename(root, root + "-preserved");
  await symlink(outside, root);
  const out = await f.command(["update", "speckit", "--target", "agents"], 5);
  assert.equal(out.data.items.length, 1);
  assert.equal(out.data.items[0].status, "failed");
  assert.equal(
    await readFile(join(outside, "speckit/sentinel"), "utf8"),
    "Preserve the other project",
  );
});

test("a failed recorded root retains its record while healthy targets continue and retry succeeds", async (t) => {
  const f = await skillFixture(t);
  await f.command([
    "install",
    "speckit",
    "--target",
    "agents",
    "--target",
    "codex",
  ]);
  const root = join(f.project, ".codex/skills");
  await rename(root, root + "-preserved");
  await writeFile(root, "Temporarily inaccessible root");
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "references/example.md": "New content\n",
  });
  const update = await f.command(["update", "speckit"], 5);
  assert.ok(
    update.data.items.some(
      (item) => item.path.includes(".agents/") && item.status === "updated",
    ),
  );
  assert.ok(
    update.data.items.some(
      (item) => item.path.includes(".codex/") && item.status === "failed",
    ),
  );
  const removed = await f.command(["uninstall", "speckit", "--yes"], 5);
  assert.ok(
    removed.data.items.some(
      (item) => item.path.includes(".agents/") && item.status === "uninstalled",
    ),
  );
  assert.ok(
    removed.data.items.some(
      (item) => item.path.includes(".codex/") && item.status === "failed",
    ),
  );
  const state = JSON.parse(
    await readFile(join(f.root, "config/skills.json"), "utf8"),
  );
  assert.equal(state.records.length, 1);
  assert.equal(state.records[0].path, join(root, "speckit"));
  await rm(root);
  await rename(root + "-preserved", root);
  const retry = await f.command(["uninstall", "speckit", "--yes"]);
  assert.equal(retry.data.items[0].status, "uninstalled");
});

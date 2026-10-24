import { test } from "node:test";
import assert from "node:assert/strict";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { startCli } from "./support.mjs";
import { skillFixture } from "./skill-support.mjs";

test("CLI input and persisted source identities reject dot path segments consistently", async (t) => {
  const f = await skillFixture(t);
  await f.command(["list"]);
  const config = join(f.root, "config/skills.json");
  const original = await readFile(config, "utf8");
  for (const repo of ["owner/.", "owner/.."]) {
    const input = await f.command(["source", "add", repo], 2);
    assert.equal(input.error.code, "INVALID_SOURCE");
    for (const field of ["sources", "records"]) {
      const state = JSON.parse(original);
      state[field].push(
        field === "sources"
          ? { repo }
          : {
              repo,
              name: "speckit",
              path: join(f.project, ".agents/skills/speckit"),
              commit: null,
            },
      );
      const invalid = JSON.stringify(state);
      await writeFile(config, invalid);
      const persisted = await f.command(["source", "list"], 2);
      assert.equal(persisted.error.code, "SKILL_CONFIG_INVALID");
      assert.equal(await readFile(config, "utf8"), invalid);
      await writeFile(config, original);
    }
  }
  await f.repo("example/normal", "normal");
  const valid = await f.command([
    "source",
    "add",
    "https://github.com/EXAMPLE/Normal.git/",
  ]);
  assert.equal(valid.data.items[0].repo, "example/normal");
});

for (const boundary of ["metadata", "archive"]) {
  test(`non-UTF8 ${boundary} SKILL.md reports invalid Skill data`, async (t) => {
    const f = await skillFixture(t);
    const repo = await f.repo("yohoia/yoho-speckit", "speckit", {
      "SKILL.md": Buffer.from([0xff, 0xfe, 0xfd]),
    });
    if (boundary === "archive") {
      repo.versions.get(repo.sha).files["SKILL.md"] =
        "---\nname: speckit\ndescription: Valid metadata\n---\n";
    }
    const result = await f.command(
      ["install", "yohoia/yoho-speckit", "--target", "agents"],
      3,
    );
    assert.equal(result.error.code, "SKILL_INVALID");
    await assert.rejects(access(join(f.project, ".agents/skills/speckit")));
    const state = JSON.parse(
      await readFile(join(f.root, "config/skills.json"), "utf8"),
    );
    assert.deepEqual(state.records, []);
  });
}

test("another Skill's backup does not block an existing or missing target", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  const path = join(f.project, ".agents/skills/speckit");
  const backup = join(
    f.project,
    ".agents/skills/.yoho-backup-speckit-extra-00000000-0000-4000-8000-000000000000",
  );
  await mkdir(backup);
  await writeFile(join(backup, "original"), "keep other Skill backup");
  const existing = await f.command(["update", "speckit", "--target", "agents"]);
  assert.equal(existing.data.items[0].status, "unchanged");
  await rm(path, { recursive: true });
  const missing = await f.command(["update", "--all", "--target", "agents"]);
  assert.equal(missing.data.total, 0);
  await f.command(["install", "speckit", "--target", "agents"]);
  assert.equal(
    await readFile(join(backup, "original"), "utf8"),
    "keep other Skill backup",
  );
});

test("batch rollback preserves a target replaced by another process", async (t) => {
  const f = await skillFixture(t);
  await f.repo(
    "yohoia/yoho-speckit",
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

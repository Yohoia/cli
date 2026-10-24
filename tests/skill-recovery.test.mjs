import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  writeFile,
  readFile,
  access,
  rename,
  rm,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { startCli, runCli } from "./support.mjs";
import { skillFixture } from "./skill-support.mjs";
test("manual source association survives failed synchronization and subsequent same-name sources", async (t) => {
  const f = await skillFixture(t);
  const path = join(f.project, ".agents/skills/speckit");
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    "---\nname: speckit\ndescription: Manual\n---\nOld\n",
  );
  const repo = f.repos.get("yohoia/yoho-speckit");
  const version = repo.versions.get(repo.sha);
  const archive = version.archive;
  version.archive = Buffer.from("bad");
  await f.command(["update", "--all", "--target", "agents"], 3);
  const record = JSON.parse(
    await readFile(join(f.root, "config/skills.json"), "utf8"),
  ).records.find((x) => x.path === path);
  assert.ok(
    record,
    "unique association must persist independently of the failed download",
  );
  assert.equal(record.commit, null);
  version.archive = archive;
  await f.repo("example/same-name", "speckit");
  await f.command(["source", "add", "example/same-name"]);
  const result = await f.command(["update", "--all", "--target", "agents"]);
  assert.equal(result.data.items[0].status, "updated");
  assert.equal(result.data.items[0].repo, "yohoia/yoho-speckit");
});
test("killed update leaves recoverable owner locks and concurrent retries cannot both reclaim a stale global lock", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  const path = join(f.project, ".agents/skills/speckit");
  await Promise.all(
    Array.from({ length: 600 }, (_, i) =>
      writeFile(join(path, `local-${i}`), "local"),
    ),
  );
  const pending = await startCli(
    ["skill", "update", "--all", "--target", "agents", "--json"],
    f.options,
  );
  const lock = join(f.project, ".agents/skills/.yoho-lock-speckit");
  let locked = false;
  for (let i = 0; i < 200; i++) {
    try {
      await access(lock);
      locked = true;
      break;
    } catch {}
    await new Promise((done) => setTimeout(done, 5));
  }
  assert.ok(locked, "update must acquire target lock");
  pending.child.kill("SIGKILL");
  await pending.result;
  for (const repo of f.repos.values()) repo.delay = 60;
  const results = await Promise.all([
    runCli(["skill", "list", "--json"], f.options),
    runCli(["skill", "list", "--json"], f.options),
  ]);
  assert.deepEqual(
    results.map((x) => x.code).sort((a, b) => a - b),
    [0, 5],
  );
  const result = await f.command(["update", "--all", "--target", "agents"]);
  assert.equal(result.data.items[0].status, "updated");
  await assert.rejects(access(join(path, "local-0")));
});
test("interrupted backups are preserved and reported rather than silently discarded", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  const backup = join(
    f.project,
    `.agents/skills/.yoho-backup-speckit-${randomUUID()}`,
  );
  await mkdir(backup);
  await writeFile(join(backup, "original"), "keep old content");
  const result = await f.command(["update", "--all", "--target", "agents"], 5);
  assert.match(result.data.items[0].message, /发现中断/);
  assert.ok(result.data.items[0].message.includes(backup));
  assert.equal(
    await readFile(join(backup, "original"), "utf8"),
    "keep old content",
  );
  await rm(join(f.project, ".agents/skills/speckit"), { recursive: true });
  const missing = await f.command(["update", "--all", "--target", "agents"], 5);
  assert.equal(missing.error.code, "SKILL_RECOVERY_REQUIRED");
  assert.ok(missing.data.items[0].message.includes(backup));
});
test("an interrupted reclaim gate reports a recovery path and can be moved aside without losing state", async (t) => {
  const f = await skillFixture(t);
  await f.command(["list"]);
  const lock = join(f.root, "config/skills.lock");
  const gate = lock + ".reclaim";
  for (const path of [lock, gate]) {
    await mkdir(path);
    await writeFile(
      join(path, "owner.json"),
      JSON.stringify({ pid: 2147483647, nonce: randomUUID() }),
    );
  }
  const result = await f.command(["source", "list"], 5);
  assert.equal(result.error.code, "SKILL_RECOVERY_REQUIRED");
  assert.ok(result.error.message.includes(gate));
  await rename(gate, gate + ".saved");
  assert.equal((await f.command(["list"])).data.total, 3);
});

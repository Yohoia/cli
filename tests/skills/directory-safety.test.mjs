import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  writeFile,
  access,
  rename,
  readdir,
  chmod,
} from "node:fs/promises";
import { renameSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { skillFixture } from "../helpers/skill-support.mjs";
import { installedCli, runCli, startCli } from "../helpers/support.mjs";

const repo = "69aa892db28d0aba0f5ed47e/yoho-speckit";
const execute = promisify(execFile);
const state = async (f) =>
  JSON.parse(await readFile(join(f.root, "config/skills.json"), "utf8"));
const manifest = (name) =>
  `---\nname: ${name}\ndescription: Local directory\n---\nKeep local content\n`;
async function manual(f) {
  const path = join(f.project, ".agents/skills/manual");
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), manifest("speckit"));
  return path;
}
function replace(path, preserved) {
  renameSync(path, preserved);
  mkdirSync(path);
  writeFileSync(join(path, "SKILL.md"), manifest("third-party"));
  writeFileSync(join(path, "sentinel"), "Keep the replacement");
}

test("first installation rejects roots redirected or replaced after download preflight", async (t) => {
  for (const kind of ["root", "ancestor", "replacement"]) {
    await t.test(kind, async (t) => {
      const f = await skillFixture(t);
      const root = join(f.project, ".agents/skills");
      const outside = join(f.root, "outside");
      await mkdir(outside);
      if (kind !== "ancestor") await mkdir(root, { recursive: true });
      let changed = false;
      f.repos.get(repo).onArchive = () => {
        if (changed) return;
        changed = true;
        if (kind === "ancestor")
          symlinkSync(outside, join(f.project, ".agents"));
        else {
          renameSync(root, root + "-preserved");
          if (kind === "root") symlinkSync(outside, root);
          else mkdirSync(root);
        }
      };
      const out = await runCli(
        ["skill", "install", "speckit", "--target", "agents", "--json"],
        f.options,
      );
      assert.ok(changed);
      assert.equal(out.code, 5, out.stdout + out.stderr);
      assert.equal(JSON.parse(out.stdout).error.code, "SKILL_TARGET_CHANGED");
      assert.deepEqual(await readdir(outside), []);
      if (kind === "replacement") assert.deepEqual(await readdir(root), []);
      assert.deepEqual((await state(f)).records, []);
    });
  }
});

test("batch rollback preserves a redirected parent and contents added to its moved installation", async (t) => {
  const f = await skillFixture(t);
  await f.repo(
    repo,
    "speckit",
    Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`references/item-${i}`, "data"]),
    ),
  );
  const first = join(f.project, ".claude/skills");
  const second = join(f.project, ".agents/skills");
  const blocked = join(f.project, ".codex/skills");
  await mkdir(second, { recursive: true });
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
  try {
    let staged = false;
    for (let i = 0; i < 2000; i++) {
      if (
        (await readdir(second)).some((name) => name.startsWith(".yoho-stage-"))
      ) {
        staged = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 1));
    }
    assert.ok(
      staged,
      "the second location is staging after the first was installed",
    );
    const preserved = join(f.root, "moved-first-root");
    await rename(first, preserved);
    await writeFile(join(preserved, "speckit/sentinel"), "Keep moved content");
    symlinkSync(preserved, first);
    const out = await pending.result;
    assert.equal(out.code, 5, out.stdout + out.stderr);
    assert.equal(JSON.parse(out.stdout).error.code, "SKILL_ROLLBACK_FAILED");
    assert.equal(
      await readFile(join(preserved, "speckit/sentinel"), "utf8"),
      "Keep moved content",
    );
    await assert.rejects(access(join(second, "speckit")), { code: "ENOENT" });
    assert.deepEqual((await state(f)).records, []);
  } finally {
    pending.child.kill("SIGKILL");
    await pending.result;
    await chmod(blocked, 0o755);
  }
});

test("a replaced manual update never leaves an association that can overwrite or uninstall the replacement", async (t) => {
  const f = await skillFixture(t);
  const path = await manual(f);
  let changed = false;
  f.repos.get(repo).onArchive = () => {
    if (changed) return;
    changed = true;
    replace(path, join(f.root, "preserved-manual"));
  };
  const failed = await f.command(
    ["update", "speckit", "--target", "agents"],
    5,
  );
  assert.equal(failed.error.code, "SKILL_TARGET_CHANGED");
  assert.deepEqual((await state(f)).records, []);
  await f.command(["update", "speckit", "--target", "agents"], 3);
  const removed = await f.command(["uninstall", "speckit", "--yes"]);
  assert.deepEqual(removed.data.items, []);
  assert.equal(
    await readFile(join(path, "sentinel"), "utf8"),
    "Keep the replacement",
  );
});

test("failed manual associations bind their directory identity across later invocations", async (t) => {
  const f = await skillFixture(t);
  const path = await manual(f);
  const version = f.repos.get(repo).versions.values().next().value;
  const archive = version.archive;
  version.archive = Buffer.from("broken archive");
  await f.command(["update", "speckit", "--target", "agents"], 3);
  const record = (await state(f)).records[0];
  assert.equal(record.commit, null);
  assert.ok(
    record.associationIdentity,
    "failed associations retain the original directory identity",
  );
  version.archive = archive;
  replace(path, join(f.root, "preserved-manual"));
  await f.command(["update", "speckit", "--target", "agents"], 3);
  assert.deepEqual((await state(f)).records, []);
  await f.command(["uninstall", "speckit", "--yes"]);
  assert.equal(
    await readFile(join(path, "sentinel"), "utf8"),
    "Keep the replacement",
  );
});

test("legacy failed associations are revalidated before trusting a third-party replacement", async (t) => {
  const f = await skillFixture(t);
  await f.command(["source", "refresh"]);
  const path = await manual(f);
  await writeFile(join(path, "SKILL.md"), manifest("third-party"));
  await writeFile(join(path, "sentinel"), "Keep the replacement");
  const original = await state(f);
  original.records.push({ repo, name: "speckit", path, commit: null });
  await writeFile(join(f.root, "config/skills.json"), JSON.stringify(original));
  const out = await f.command(["update", "--all", "--target", "agents"]);
  assert.deepEqual(out.data.items, []);
  assert.deepEqual((await state(f)).records, []);
  await f.command(["uninstall", "speckit", "--yes"]);
  assert.equal(
    await readFile(join(path, "sentinel"), "utf8"),
    "Keep the replacement",
  );
});

test("a failed manual uninstall retains only its original directory's source association", async (t) => {
  const f = await skillFixture(t);
  await f.command(["source", "refresh"]);
  const path = await manual(f);
  const root = join(f.project, ".agents/skills");
  await chmod(root, 0o555);
  try {
    const failed = await f.command(["uninstall", "speckit", "--yes"], 4);
    assert.equal(failed.data.items[0].status, "failed");
    const record = (await state(f)).records[0];
    assert.equal(record.repo, repo);
    assert.ok(record.associationIdentity);
    await access(join(path, "SKILL.md"));
  } finally {
    await chmod(root, 0o755);
  }
  await f.repo("example/same-name", "speckit");
  await f.command(["source", "add", "example/same-name"]);
  await f.command(["source", "refresh"]);
  const removed = await f.command(["uninstall", repo, "--yes"]);
  assert.equal(removed.data.items[0].status, "uninstalled");
  assert.deepEqual((await state(f)).records, []);
  await assert.rejects(access(path), { code: "ENOENT" });
});

test("an interrupted manual replacement keeps its original backup and association until recovery", async (t) => {
  const f = await skillFixture(t);
  const path = await manual(f);
  const version = f.repos.get(repo).versions.values().next().value;
  const archive = version.archive;
  version.archive = Buffer.from("broken archive");
  await f.command(["update", "speckit", "--target", "agents"], 3);
  version.archive = archive;
  const backup = join(
    f.project,
    `.agents/skills/.yoho-backup-manual-${randomUUID()}`,
  );
  replace(path, backup);
  const failed = await f.command(
    ["update", "speckit", "--target", "agents"],
    5,
  );
  assert.equal(failed.error.code, "SKILL_RECOVERY_REQUIRED");
  assert.equal((await state(f)).records.length, 1);
  assert.equal(
    await readFile(join(path, "sentinel"), "utf8"),
    "Keep the replacement",
  );
  await rename(path, join(f.root, "preserved-third-party"));
  await rename(backup, path);
  await f.command(["update", "speckit", "--target", "agents"]);
  const complete = (await state(f)).records[0];
  assert.ok(complete.commit);
  assert.equal(complete.associationIdentity, undefined);
});

test("uninstall confirmation cannot turn a replaced manual directory into a managed installation", async (t) => {
  const f = await skillFixture(t);
  await f.command(["source", "refresh"]);
  const path = await manual(f);
  const script = `
import json, os, pty, select, subprocess, sys, time, fcntl, termios, struct
command, path, preserved = json.loads(sys.argv[1]), sys.argv[2], sys.argv[3]
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
child = subprocess.Popen(command, stdin=slave, stderr=slave, stdout=subprocess.PIPE)
os.close(slave)
terminal = b''
changed = False
deadline = time.monotonic() + 12
try:
    while time.monotonic() < deadline:
        if not select.select([master], [], [], 0.05)[0]: continue
        try: chunk = os.read(master, 65536)
        except OSError: break
        if not chunk: break
        terminal += chunk
        if not changed and '确认删除以上文件和安装记录'.encode() in terminal:
            changed = True
            os.rename(path, preserved)
            os.mkdir(path)
            with open(os.path.join(path, 'SKILL.md'), 'w') as file: file.write('---\\nname: third-party\\ndescription: Foreign\\n---\\nKeep\\n')
            with open(os.path.join(path, 'sentinel'), 'w') as file: file.write('Keep the replacement')
            os.write(master, b'\\x1b[B\\r')
    if child.poll() is None: child.kill()
    stdout, _ = child.communicate()
    print(json.dumps({'code': child.returncode, 'stdout': stdout.decode(), 'terminal': terminal.decode(errors='replace'), 'changed': changed}))
finally:
    if child.poll() is None: child.kill(); child.wait()
    os.close(master)
`;
  const { stdout } = await execute(
    "python3",
    [
      "-c",
      script,
      JSON.stringify([
        process.execPath,
        await installedCli(),
        "skill",
        "uninstall",
        "speckit",
        "--json",
      ]),
      path,
      join(f.root, "preserved-manual"),
    ],
    {
      cwd: f.project,
      env: {
        ...process.env,
        ...f.options.env,
        TERM: "xterm-256color",
        NO_COLOR: "1",
      },
      timeout: 15000,
    },
  );
  const out = JSON.parse(stdout);
  assert.ok(out.changed, out.terminal);
  assert.equal(out.code, 5, out.stdout + out.terminal);
  assert.equal(JSON.parse(out.stdout).error.code, "SKILL_TARGET_CHANGED");
  assert.deepEqual((await state(f)).records, []);
  await f.command(["uninstall", "speckit", "--yes"]);
  assert.equal(
    await readFile(join(path, "sentinel"), "utf8"),
    "Keep the replacement",
  );
});

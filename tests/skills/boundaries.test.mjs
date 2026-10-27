import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import {
  mkdir,
  symlink,
  readFile,
  writeFile,
  access,
  stat,
} from "node:fs/promises";
import { installedCli } from "../helpers/support.mjs";
import { skillFixture } from "../helpers/skill-support.mjs";

const execute = promisify(execFile);
test("a moving default branch does not mix commits across targets, and physical targets are deduplicated", async (t) => {
  const f = await skillFixture(t);
  const repo = f.repos.get("69aa892db28d0aba0f5ed47e/yoho-speckit");
  const first = repo.sha;
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "references/example.md": "Second commit\n",
  });
  const second = repo.sha;
  repo.sha = first;
  repo.onArchive = () => {
    repo.sha = second;
  };
  await mkdir(join(f.project, ".claude/skills"), { recursive: true });
  await mkdir(join(f.project, ".agents"));
  await symlink(
    join(f.project, ".claude/skills"),
    join(f.project, ".agents/skills"),
  );
  const result = await f.command([
    "install",
    "speckit",
    "--target",
    "claude",
    "--target",
    "agents",
    "--target",
    "codex",
  ]);
  assert.equal(result.data.items.length, 2);
  assert.ok(result.data.items.every((x) => x.commit === first));
  assert.equal(
    await readFile(
      join(f.project, ".codex/skills/speckit/references/example.md"),
      "utf8",
    ),
    "Reference one\n",
  );
  await f.command(["update", "speckit", "--target", "codex"]);
  assert.equal(
    await readFile(
      join(f.project, ".codex/skills/speckit/references/example.md"),
      "utf8",
    ),
    "Second commit\n",
  );
  const aliased = await f.command(["update", "speckit", "--target", "agents"]);
  assert.equal(aliased.data.items.length, 1);
  assert.equal(
    aliased.data.items[0].path,
    join(f.project, ".claude/skills/speckit"),
  );
  assert.equal(aliased.data.items[0].status, "updated");
});
test("unsafe archive paths are rejected before writing and complete installs exclude Git metadata without executing hooks", async (t) => {
  const f = await skillFixture(t);
  const marker = join(f.root, "executed");
  await f.repo("example/resources", "resources", {
    ".git/config": "metadata",
    "package.json": JSON.stringify({ scripts: { install: `touch ${marker}` } }),
    "assets/image.png": Buffer.from([0, 1, 2, 3]),
  });
  await f.command(["source", "add", "example/resources"]);
  await f.command(["install", "resources", "--target", "agents"]);
  assert.deepEqual(
    await readFile(
      join(f.project, ".agents/skills/resources/assets/image.png"),
    ),
    Buffer.from([0, 1, 2, 3]),
  );
  await assert.rejects(access(marker));
  await assert.rejects(
    access(join(f.project, ".agents/skills/resources/.git")),
  );
  const code =
    "import tarfile,io,sys\nb=io.BytesIO()\nwith tarfile.open(fileobj=b,mode='w:gz') as t:\n for name in ['repository/SKILL.md','repository/../escape']:\n  x=tarfile.TarInfo(name); x.size=3; t.addfile(x,io.BytesIO(b'bad'))\nsys.stdout.buffer.write(b.getvalue())";
  const { stdout } = await execute("python3", ["-c", code], {
    encoding: "buffer",
  });
  const repo = f.repos.get("69aa892db28d0aba0f5ed47e/yoho-speckit");
  repo.versions.get(repo.sha).archive = stdout;
  const result = await f.command(
    ["install", "speckit", "--target", "agents"],
    3,
  );
  assert.equal(result.error.code, "SKILL_ARCHIVE_INVALID");
  await assert.rejects(access(join(f.project, ".agents/skills/escape")));
  await assert.rejects(access(join(f.project, ".agents/skills/speckit")));
});
test("a real record write failure after replacement restores the manual target, while other targets remain updated", async (t) => {
  const f = await skillFixture(t);
  const remoteManifest = `---\nname: speckit\ndescription: Test speckit\nversion: 1.0.0+${"build".repeat(80)}\n---\n# speckit\n`;
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "SKILL.md": remoteManifest,
  });
  await f.command([
    "install",
    "speckit",
    "--target",
    "claude",
    "--target",
    "agents",
  ]);
  const manual = join(f.project, ".codex/skills/speckit");
  await mkdir(manual, { recursive: true });
  const original =
    "---\nname: speckit\ndescription: Manual\n---\nOriginal manual content\n";
  await writeFile(join(manual, "SKILL.md"), original);
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "SKILL.md": remoteManifest,
    "references/example.md": "Updated\n",
  });
  const source = f.repos.get("69aa892db28d0aba0f5ed47e/yoho-speckit");
  const version = source.versions.get(source.sha);
  const archive = version.archive;
  version.archive = Buffer.from("bad");
  await f.command(["update", "speckit", "--target", "codex"], 3);
  version.archive = archive;
  // Existing managed records already contain the declared version; committing the manual target adds it.
  const limit = (await stat(join(f.root, "config/skills.json"))).size + 20;
  const script =
    "import os,sys,resource,signal\nresource.setrlimit(resource.RLIMIT_FSIZE,(int(sys.argv[1]),int(sys.argv[1])))\nsignal.signal(signal.SIGXFSZ,signal.SIG_IGN)\nos.execv(sys.argv[2],sys.argv[2:])";
  let out;
  try {
    await execute(
      "python3",
      [
        "-c",
        script,
        String(limit),
        process.execPath,
        await installedCli(),
        "skill",
        "update",
        "--all",
        "--target",
        "claude",
        "--target",
        "codex",
        "--target",
        "agents",
        "--json",
      ],
      { cwd: f.project, env: { ...process.env, ...f.options.env } },
    );
    assert.fail("expected record write failure");
  } catch (error) {
    out = error;
  }
  assert.equal(out.code, 5, out.stdout + out.stderr);
  const data = JSON.parse(out.stdout).data;
  assert.equal(data.items.filter((x) => x.status === "updated").length, 2);
  assert.equal(await readFile(join(manual, "SKILL.md"), "utf8"), original);
  assert.equal(
    await readFile(
      join(f.project, ".agents/skills/speckit/references/example.md"),
      "utf8",
    ),
    "Updated\n",
  );
  const records = JSON.parse(
    await readFile(join(f.root, "config/skills.json"), "utf8"),
  ).records;
  assert.equal(records.find((x) => x.path === manual).commit, null);
});

for (const boundary of ["metadata", "archive"]) {
  test(`non-UTF8 ${boundary} SKILL.md reports invalid Skill data`, async (t) => {
    const f = await skillFixture(t);
    const repo = await f.repo(
      "69aa892db28d0aba0f5ed47e/yoho-speckit",
      "speckit",
      {
        "SKILL.md": Buffer.from([0xff, 0xfe, 0xfd]),
      },
    );
    if (boundary === "archive") {
      repo.versions.get(repo.sha).files["SKILL.md"] =
        "---\nname: speckit\ndescription: Valid metadata\n---\n";
    }
    const result = await f.command(
      [
        "install",
        "69aa892db28d0aba0f5ed47e/yoho-speckit",
        "--target",
        "agents",
      ],
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

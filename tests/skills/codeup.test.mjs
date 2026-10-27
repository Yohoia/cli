import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { skillFixture } from "../helpers/skill-support.mjs";
import { startCli } from "../helpers/support.mjs";

const namespace = "69aa892db28d0aba0f5ed47e";

test("legacy GitHub registrations and installed records migrate only known Codeup mirrors", async (t) => {
  const f = await skillFixture(t);
  const path = join(f.project, ".agents/skills/speckit");
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "SKILL.md"),
    "---\nname: speckit\ndescription: Old\n---\nOld\n",
  );
  const legacyPath = join(f.project, ".agents/skills/unknown");
  await mkdir(legacyPath);
  await writeFile(
    join(legacyPath, "SKILL.md"),
    "---\nname: unknown\ndescription: Legacy\n---\nKeep\n",
  );
  const config = join(f.root, "config/skills.json");
  await mkdir(join(f.root, "config"), { recursive: true });
  const commit = f.repos.get(`${namespace}/yoho-speckit`).sha;
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      sources: [{ repo: "yohoia/yoho-speckit" }, { repo: "other/unknown" }],
      records: [
        {
          repo: "yohoia/yoho-speckit",
          name: "speckit",
          path,
          commit,
          version: "1.0.0",
        },
        {
          repo: "other/unknown",
          name: "unknown",
          path: legacyPath,
          commit: null,
        },
      ],
    }),
  );
  const listed = await f.command(["list"]);
  assert.equal(listed.data.total, 1);
  assert.equal(listed.data.available, 1);
  const state = JSON.parse(await readFile(config, "utf8"));
  assert.equal(state.version, 2);
  assert.deepEqual(
    state.sources.map((s) => s.repo),
    [`${namespace}/yoho-speckit`, "other/unknown"],
  );
  assert.equal(state.sources[1].legacyGithub, true);
  assert.deepEqual(state.records[0], {
    repo: `${namespace}/yoho-speckit`,
    name: "speckit",
    path,
    commit,
    version: "1.0.0",
  });
  assert.ok(!f.requests.some((r) => r.url.includes("other/unknown")));
  const unknown = listed.data.items.find((s) => s.repo === "other/unknown");
  assert.equal(unknown.status, "unavailable");
  assert.match(unknown.message, /Codeup 映射/);
  assert.equal(
    (await f.command(["install", "other/unknown", "--target", "agents"], 2))
      .error.code,
    "SOURCE_MIGRATION_REQUIRED",
  );
  assert.ok(!f.requests.some((r) => r.url.includes("other/unknown")));
  await f.command(["update", "speckit", "--target", "agents"]);
  assert.match(await readFile(join(path, "SKILL.md"), "utf8"), /Test speckit/);
  const blocked = await f.command(
    ["update", "unknown", "--target", "agents"],
    2,
  );
  assert.equal(blocked.data.items[0].status, "failed");
  const interactive = await f.terminal(["update"], []);
  assert.equal(interactive.code, 2, interactive.stdout + interactive.terminal);
  assert.ok(!f.requests.some((r) => r.url.includes("other/unknown")));
  assert.match(await readFile(join(legacyPath, "SKILL.md"), "utf8"), /Keep/);
});

test("migration keeps removed sources removed and does not access any remote for source list", async (t) => {
  const f = await skillFixture(t);
  const config = join(f.root, "config/skills.json");
  await mkdir(join(f.root, "config"), { recursive: true });
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      sources: [],
      records: [
        {
          repo: "yohoia/yoho-speckit",
          name: "speckit",
          path: join(f.project, ".agents/skills/speckit"),
          commit: null,
        },
      ],
    }),
  );
  assert.equal((await f.command(["source", "list"])).data.total, 0);
  const state = JSON.parse(await readFile(config, "utf8"));
  assert.equal(state.records[0].repo, `${namespace}/yoho-speckit`);
  assert.equal(f.requests.length, 0);
});

test("Codeup source URLs preserve case and nested groups and reject other hosts and path escapes", async (t) => {
  const f = await skillFixture(t);
  await f.repo("Team/Group/MySkill", "nested-skill");
  for (const value of [
    "https://codeup.aliyun.com/Team/Group/MySkill.git/",
    "git@codeup.aliyun.com:Team/Group/MySkill.git",
    "ssh://git@codeup.aliyun.com/Team/Group/MySkill.git",
  ])
    assert.equal(
      (await f.command(["source", "add", value])).data.items[0].repo,
      "Team/Group/MySkill",
    );
  assert.equal((await f.command(["source", "list"])).data.total, 4);
  await f.command(["install", "Team/Group/MySkill", "--target", "agents"]);
  for (const value of [
    "https://github.com/Team/MySkill",
    "git@github.com:Team/MySkill.git",
    "https://codeup.aliyun.com/Team/../escape",
    "Team/Group//bad",
    "ssh://git:secret@codeup.aliyun.com/Team/repo",
    "https://codeup.aliyun.com/Team/repo?token=secret",
  ])
    assert.equal(
      (await f.command(["source", "add", value], 2)).error.code,
      "INVALID_SOURCE",
    );
});

test("warm list checks Codeup HEAD without downloading resource blobs or consulting gh", async (t) => {
  const f = await skillFixture(t);
  const marker = join(f.root, "gh-executed");
  await writeFile(
    join(f.root, "bin/gh"),
    `#!/bin/sh\ntouch '${marker}'\nexit 99\n`,
    { mode: 0o755 },
  );
  f.options.env.GH_TOKEN = "must-not-be-used";
  assert.equal((await f.command(["list"])).data.available, 3);
  const before = f.requests.length;
  assert.equal((await f.command(["list"])).data.available, 3);
  const requests = f.requests.slice(before);
  assert.equal(
    requests.filter((r) => r.url.startsWith("/transport/")).length,
    3,
  );
  assert.ok(!f.requests.some((r) => r.url.startsWith("/archive/")));
  assert.ok(
    !f.requests.some((r) => r.authorization?.includes("must-not-be-used")),
  );
  await assert.rejects(access(marker));
});

test("cancelling an in-flight Codeup read stops Git children and releases the state lock", async (t) => {
  const f = await skillFixture(t);
  for (const repo of f.repos.values()) repo.delay = 1000;
  const pending = await startCli(["skill", "list", "--json"], f.options);
  for (let i = 0; i < 100 && !f.requests.length; i++)
    await new Promise((done) => setTimeout(done, 10));
  assert.ok(f.requests.length);
  pending.child.kill("SIGINT");
  const result = await pending.result;
  assert.equal(result.code, 130, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, "CANCELLED");
  for (const repo of f.repos.values()) repo.delay = 0;
  assert.equal((await f.command(["list"])).data.available, 3);
});

test("installation fetches resource blobs together, preserves executable bits, and ignores export attributes", async (t) => {
  const f = await skillFixture(t);
  const resources = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [
      `assets/resource-${i}.txt`,
      `Resource ${i}\n`,
    ]),
  );
  await f.repo(`${namespace}/yoho-speckit`, "speckit", {
    ...resources,
    ".gitattributes":
      "assets/resource-0.txt export-ignore\nreferences/literal.md export-subst\n",
    "references/literal.md": "$Format:%H$\n",
    "scripts/run.sh": {
      bytes: "#!/bin/sh\necho SHOULD_NOT_RUN\n",
      mode: "100755",
    },
  });
  await f.command(["list"]);
  const before = f.requests.length;
  await f.command(["install", "speckit", "--target", "agents"]);
  const target = join(f.project, ".agents/skills/speckit");
  for (const [name, bytes] of Object.entries(resources))
    assert.equal(await readFile(join(target, name), "utf8"), bytes);
  assert.equal(
    await readFile(join(target, "references/literal.md"), "utf8"),
    "$Format:%H$\n",
  );
  assert.ok((await stat(join(target, "scripts/run.sh"))).mode & 0o111);
  assert.ok(
    f.requests.slice(before).filter((r) => r.url.startsWith("/transport/"))
      .length <= 4,
  );
});

test("a real Git symlink entry is rejected before creating an installation", async (t) => {
  const f = await skillFixture(t);
  await f.repo(`${namespace}/yoho-speckit`, "speckit", {
    linked: { bytes: "../outside", mode: "120000" },
  });
  const result = await f.command(
    ["install", "speckit", "--target", "agents"],
    3,
  );
  assert.equal(result.error.code, "SKILL_ARCHIVE_INVALID");
  await assert.rejects(access(join(f.project, ".agents/skills/speckit")));
});

test("default SSH handles quoted configuration paths and a relative private-key path", async (t) => {
  const f = await skillFixture(t);
  const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const ssh = execFileSync("which", ["ssh"], { encoding: "utf8" }).trim();
  await writeFile(
    join(f.root, "bin/ssh"),
    `#!/bin/sh\nset -e\n${quote(ssh)} -G -F /dev/null "$@" > /dev/null\nexec ${quote(process.execPath)} ${quote(resolve("tests/helpers/codeup-git.mjs"))} ssh "$@"\n`,
    { mode: 0o755 },
  );
  f.options.env.GIT_SSH_COMMAND = "";
  f.options.env.YOHO_CONFIG_DIR = join(f.root, "配置 with ' spaces");
  f.options.env.YOHO_SKILL_SSH_KEY = "./密钥 with ' spaces";
  await writeFile(
    join(f.project, "密钥 with ' spaces"),
    "isolated test key, never used for real SSH",
  );
  assert.equal((await f.command(["list"])).data.available, 3);
});

test("missing Codeup HEAD retries, accepts a sole live branch, and rejects ambiguous branches without using cached commits", async (t) => {
  const f = await skillFixture(t);
  const repo = f.repos.get(`${namespace}/yoho-speckit`);
  repo.extraBranch = true;
  repo.emptyHeads = 2;
  assert.equal((await f.command(["list"])).data.available, 3);
  repo.emptyHeads = 100;
  const item = (await f.command(["list"])).data.items.find(
    (x) => x.name === "speckit",
  );
  assert.equal(item.status, "unavailable");
  assert.match(item.message, /默认分支提交/);
  const failed = await f.command(
    ["install", "speckit", "--target", "agents"],
    5,
  );
  assert.equal(failed.error.code, "SOURCE_PROTOCOL_ERROR");
  await assert.rejects(access(join(f.project, ".agents/skills/speckit")));
  repo.extraBranch = false;
  execFileSync(f.options.env.YOHO_TEST_REAL_GIT, [
    "--git-dir",
    repo.path,
    "update-ref",
    "-d",
    "refs/heads/extra",
  ]);
  assert.equal((await f.command(["list"])).data.available, 3);
});

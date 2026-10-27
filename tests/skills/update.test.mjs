import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  rm,
  mkdir,
  access,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { skillFixture } from "../helpers/skill-support.mjs";
test("update restores repository authority even at the same commit and adopts manual skills", async (t) => {
  const f = await skillFixture(t);
  await f.command(["install", "speckit", "--target", "agents"]);
  const path = join(f.project, ".agents/skills/speckit");
  await writeFile(join(path, "SKILL.md"), "my changes");
  await rm(join(path, "references/example.md"));
  await writeFile(join(path, "personal.txt"), "remove me");
  let data = (await f.command(["update", "speckit", "--target", "agents"]))
    .data;
  assert.equal(data.items[0].status, "updated");
  assert.match(await readFile(join(path, "SKILL.md"), "utf8"), /name: speckit/);
  await assert.rejects(access(join(path, "personal.txt")));
  assert.equal(
    await readFile(join(path, "references/example.md"), "utf8"),
    "Reference one\n",
  );
  data = (await f.command(["update", "speckit", "--target", "agents"])).data;
  assert.equal(data.items[0].status, "unchanged");
  const manual = join(f.project, ".claude/skills/custom-folder");
  await mkdir(manual, { recursive: true });
  await writeFile(
    join(manual, "SKILL.md"),
    "---\nname: speckit\ndescription: Local\n---\nOld",
  );
  data = (await f.command(["update", "--all", "--target", "claude"])).data;
  assert.equal(data.items[0].status, "updated");
  assert.equal(data.items[0].path, manual);
  const listed = (
    await f.command(["list", "--target", "claude"])
  ).data.items.find((x) => x.name === "speckit");
  assert.equal(listed.targets[0].installed, true);
  assert.equal(listed.targets[0].path, manual);
  const repeated = (
    await f.command(["install", "speckit", "--target", "claude"])
  ).data;
  assert.equal(repeated.items[0].status, "skipped");
  assert.equal(repeated.items[0].path, manual);
  await f.command([
    "source",
    "remove",
    "69aa892db28d0aba0f5ed47e/yoho-speckit",
  ]);
  data = (await f.command(["update", "--all", "--target", "claude"])).data;
  assert.equal(data.items[0].status, "skipped");
  assert.match(data.items[0].message, /移除/);
  await f.command(["source", "add", "69aa892db28d0aba0f5ed47e/yoho-speckit"]);
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "references/example.md": "New\n",
  });
  await f.command(["update", "--all", "--target", "claude"]);
  assert.equal(
    await readFile(join(manual, "references/example.md"), "utf8"),
    "New\n",
  );
});
test("one failed update restores that target and preserves successful targets", async (t) => {
  const f = await skillFixture(t);
  await f.command([
    "install",
    "speckit",
    "--target",
    "claude",
    "--target",
    "codex",
    "--target",
    "agents",
  ]);
  await f.repo("69aa892db28d0aba0f5ed47e/yoho-speckit", "speckit", {
    "references/example.md": "Version two\n",
  });
  const blocked = join(f.project, ".codex/skills");
  await chmod(blocked, 0o555);
  try {
    const out = await f.command(
      [
        "update",
        "--all",
        "--target",
        "claude",
        "--target",
        "codex",
        "--target",
        "agents",
      ],
      4,
    );
    assert.equal(out.ok, false);
    assert.equal(
      out.data.items.filter((x) => x.status === "updated").length,
      2,
    );
    assert.equal(out.data.items.filter((x) => x.status === "failed").length, 1);
    assert.equal(
      await readFile(join(blocked, "speckit/references/example.md"), "utf8"),
      "Reference one\n",
    );
    assert.equal(
      await readFile(
        join(f.project, ".claude/skills/speckit/references/example.md"),
        "utf8",
      ),
      "Version two\n",
    );
  } finally {
    await chmod(blocked, 0o755);
  }
});

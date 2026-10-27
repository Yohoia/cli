import { test } from "node:test";
import assert from "node:assert/strict";
import { skillFixture } from "../helpers/skill-support.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

test("installed CLI lists root skills, registers another source and remembers removal", async (t) => {
  const f = await skillFixture(t);
  let data = (await f.command(["list"])).data;
  assert.equal(data.total, 3);
  assert.equal(
    data.items.find((x) => x.repo.endsWith("yoho-speckit")).name,
    "speckit",
  );
  await f.repo("example/fourth", "fourth");
  await f.command([
    "source",
    "add",
    "https://codeup.aliyun.com/example/fourth",
  ]);
  assert.equal((await f.command(["list"])).data.total, 4);
  await f.command([
    "source",
    "remove",
    "69aa892db28d0aba0f5ed47e/yoho-standard-readme",
  ]);
  data = (await f.command(["source", "list"])).data;
  assert.equal(data.items.length, 3);
  assert.ok(!data.items.some((x) => x.repo.endsWith("yoho-standard-readme")));
});

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
    "https://codeup.aliyun.com/example/normal.git/",
  ]);
  assert.equal(valid.data.items[0].repo, "example/normal");
});

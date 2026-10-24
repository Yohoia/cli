import { test } from "node:test";
import assert from "node:assert/strict";
import { skillFixture } from "./skill-support.mjs";
test("installed CLI lists root skills, registers another source and remembers removal", async (t) => {
  const f = await skillFixture(t);
  let data = (await f.command(["list"])).data;
  assert.equal(data.total, 3);
  assert.equal(
    data.items.find((x) => x.repo.endsWith("yoho-speckit")).name,
    "speckit",
  );
  await f.repo("example/fourth", "fourth");
  await f.command(["source", "add", "https://github.com/example/fourth"]);
  assert.equal((await f.command(["list"])).data.total, 4);
  await f.command(["source", "remove", "Yohoia/yoho-standard-readme"]);
  data = (await f.command(["source", "list"])).data;
  assert.equal(data.items.length, 3);
  assert.ok(!data.items.some((x) => x.repo.endsWith("yoho-standard-readme")));
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, article, runCli, startCli } from "./support.mjs";

test("读取后的版本可用于条件更新，过期版本保留当前内容", async (t) => {
  const project = await fixture(t);
  const file = await project.write("knn.md", article());
  const shown = await runCli(["blog", "show", "knn", "--json"], {
    cwd: project.root,
  });
  const old = JSON.parse(shown.stdout).data.revision;
  const success = await runCli(
    ["blog", "update", "knn", "--title", "新标题", "--if-match", old, "--json"],
    { cwd: project.root },
  );
  assert.equal(success.code, 0, success.stdout);
  const revision = JSON.parse(success.stdout).data.revision;
  assert.notEqual(revision, old);
  const current = await readFile(file, "utf8");
  for (const title of ["别的标题", "新标题"]) {
    const stale = await runCli(
      ["blog", "update", "knn", "--title", title, "--if-match", old, "--json"],
      { cwd: project.root },
    );
    assert.equal(stale.code, 3, stale.stdout);
    assert.equal(JSON.parse(stale.stdout).error.code, "ARTICLE_CONFLICT");
    assert.equal(await readFile(file, "utf8"), current);
  }
  await writeFile(file, current + "手动修改正文\n");
  const changedBody = await runCli(
    [
      "blog",
      "update",
      "knn",
      "--title",
      "再次修改",
      "--if-match",
      revision,
      "--json",
    ],
    { cwd: project.root },
  );
  assert.equal(changedBody.code, 3, changedBody.stdout);
});

test("并发条件更新最多成功一次，即使文件系统替换缓慢", async (t) => {
  const project = await fixture(t);
  const file = await project.write("knn.md", article());
  const shown = await runCli(["blog", "show", "knn", "--json"], {
    cwd: project.root,
  });
  const revision = JSON.parse(shown.stdout).data.revision;
  const preload = join(project.root, "slow-filesystem.cjs");
  await writeFile(
    preload,
    `const fs = require('node:fs/promises'); const delay = require('node:timers/promises').setTimeout; const original = fs.rename; fs.rename = async (from,to) => { if (to === process.env.YOHO_FAULT_TARGET) await delay(200); return original(from,to); };`,
  );
  const results = await Promise.all(
    ["并发标题甲", "并发标题乙", "并发标题丙"].map((title) =>
      runCli(
        [
          "blog",
          "update",
          "knn",
          "--title",
          title,
          "--if-match",
          revision,
          "--json",
        ],
        {
          cwd: project.root,
          env: {
            NODE_OPTIONS: `--require=${preload}`,
            YOHO_FAULT_TARGET: file,
          },
        },
      ),
    ),
  );
  assert.equal(
    results.filter((result) => result.code === 0).length,
    1,
    JSON.stringify(results),
  );
  for (const result of results.filter((result) => result.code !== 0)) {
    assert.equal(result.code, 3, result.stdout);
    assert.equal(JSON.parse(result.stdout).error.code, "ARTICLE_CONFLICT");
  }
  const current = await runCli(["blog", "show", "knn", "--json"], {
    cwd: project.root,
  });
  const winner = JSON.parse(
    results.find((result) => result.code === 0).stdout,
  ).data;
  assert.equal(JSON.parse(current.stdout).data.metadata.title, winner.title);
  assert.equal(JSON.parse(current.stdout).data.revision, winner.revision);
});

test("读取过程中取消会返回 130 与单个 JSON 结果，文件保持不变", async (t) => {
  const project = await fixture(t);
  const source = article();
  const file = await project.write("knn.md", source);
  const preload = join(project.root, "slow-read.cjs");
  await writeFile(
    preload,
    `const fs = require('node:fs/promises'); const delay = require('node:timers/promises').setTimeout; const original = fs.readFile; fs.readFile = async (path, options) => { if (path === process.env.YOHO_FAULT_TARGET) { process.stderr.write('test: read pending\\n'); await delay(5000, undefined, {signal:options.signal}); } return original(path,options); };`,
  );
  const { child, result } = await startCli(
    ["blog", "update", "knn", "--title", "新标题", "--json"],
    {
      cwd: project.root,
      env: { NODE_OPTIONS: `--require=${preload}`, YOHO_FAULT_TARGET: file },
    },
  );
  child.stderr.on("data", (chunk) => {
    if (chunk.includes("test: read pending")) child.kill("SIGINT");
  });
  const cancelled = await result;
  assert.equal(cancelled.code, 130, JSON.stringify(cancelled));
  assert.equal(JSON.parse(cancelled.stdout).error.code, "CANCELLED");
  assert.equal(await readFile(file, "utf8"), source);
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../helpers/support.mjs";

for (const legacy of ["--project", "blog update"]) {
  test(`已安装CLI拒绝旧用法 ${legacy} 并保留全部本地文件`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "yoho-migration-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const content = join(root, "content", "blog");
    await mkdir(content, { recursive: true });
    const document = join(content, "entry.md");
    const source =
      "---\ntitle: 本地原稿\nstatus: draft\n---\n\n本地正文应保持不变。\n";
    await writeFile(document, source);
    const before = await readdir(root, { recursive: true });
    const args =
      legacy === "--project"
        ? ["--project", root, "blog", "list", "--json"]
        : ["blog", "update", "entry", "--title", "不应保存的新标题", "--json"];
    const result = await runCli(args, {
      cwd: root,
      env: {
        YOHO_SERVER: "http://127.0.0.1:9",
        YOHO_TOKEN: "unused-migration-test-token",
        YOHO_CONFIG_DIR: join(root, "config"),
      },
    });
    assert.equal(result.code, 2, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "LOCAL_MODE_REMOVED");
    assert.match(response.error.message, /远程/);
    assert.match(
      response.error.message,
      legacy === "--project" ? /blog (list|create)/ : /PageHush|网页/,
    );
    assert.equal(await readFile(document, "utf8"), source);
    assert.deepEqual(await readdir(root, { recursive: true }), before);
  });
}

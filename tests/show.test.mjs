import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fixture, article, runCli } from "./support.mjs";

test("查看完整文章，保留未知字段和原始图片引用，并返回稳定文章版本", async (t) => {
  const project = await fixture(t);
  const body = "\n# 正文标题\n![图片](../../assets/images/cover.png)\n";
  const source = article({
    extra: "author: Yoho\nthumbnail: ../../assets/images/cover.png\n",
    body,
  });
  const file = await project.write("nested/knn.mdx", source);
  const first = await runCli(["blog", "show", "nested/knn", "--json"], {
    cwd: project.root,
  });
  assert.equal(first.code, 0, first.stdout);
  const { data } = JSON.parse(first.stdout);
  assert.equal(data.id, "nested/knn");
  assert.equal(data.path, file);
  assert.equal(data.metadata.author, "Yoho");
  assert.equal(data.metadata.thumbnail, "../../assets/images/cover.png");
  assert.equal(data.content, body);
  assert.equal(typeof data.revision, "string");
  assert.ok(data.revision.length > 0);
  const again = await runCli(["blog", "show", "nested/knn", "--json"], {
    cwd: project.root,
  });
  assert.equal(JSON.parse(again.stdout).data.revision, data.revision);
  assert.equal(await readFile(file, "utf8"), source);
  await writeFile(file, source + "新的一段\n");
  const changed = await runCli(["blog", "show", "nested/knn", "--json"], {
    cwd: project.root,
  });
  assert.notEqual(JSON.parse(changed.stdout).data.revision, data.revision);
});

test("只检查目标文章，并清晰处理不存在与有歧义的目标", async (t) => {
  const project = await fixture(t);
  await project.write("good.md", article());
  await project.write("broken.md", "---\ntitle: [\n---\n");
  const good = await runCli(["blog", "show", "good", "--json"], {
    cwd: project.root,
  });
  assert.equal(good.code, 0);
  const broken = await runCli(["blog", "show", "broken", "--json"], {
    cwd: project.root,
  });
  assert.equal(broken.code, 3);
  const missing = await runCli(["blog", "show", "missing", "--json"], {
    cwd: project.root,
  });
  assert.equal(missing.code, 3);
  assert.equal(JSON.parse(missing.stdout).error.code, "ARTICLE_NOT_FOUND");
  await project.write("good.mdx", article());
  const ambiguous = await runCli(["blog", "show", "good", "--json"], {
    cwd: project.root,
  });
  assert.equal(ambiguous.code, 3);
  assert.equal(JSON.parse(ambiguous.stdout).error.code, "ARTICLE_ID_AMBIGUOUS");
});

test("目录遍历和指向内容目录外的符号链接被拒绝", async (t) => {
  const project = await fixture(t);
  const outside = join(project.root, "outside.md");
  await writeFile(outside, article());
  await symlink(outside, join(project.content, "escape.md"));
  for (const id of [
    "../outside",
    "escape",
    outside,
    "nested/../../outside",
    "C:\\outside",
    "bad\\name",
  ]) {
    const result = await runCli(["blog", "show", id, "--json"], {
      cwd: project.root,
    });
    assert.equal(result.code, 2, `${id}: ${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).ok, false);
  }
});

test("以两个点开头的正常文件名不是目录遍历", async (t) => {
  const project = await fixture(t);
  await project.write("..notes.md", article());
  const result = await runCli(["blog", "show", "..notes", "--json"], {
    cwd: project.root,
  });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).data.id, "..notes");
});

test("无法表示为 JSON 的循环元数据作为文章数据错误报告", async (t) => {
  const project = await fixture(t);
  await project.write(
    "cycle.md",
    article({ extra: "custom: &loop [*loop]\n" }),
  );
  const result = await runCli(["blog", "show", "cycle", "--json"], {
    cwd: project.root,
  });
  assert.equal(result.code, 3, result.stdout);
  assert.equal(JSON.parse(result.stdout).error.code, "ARTICLE_INVALID");
});

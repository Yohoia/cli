import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { article, fixture, runCli } from "./support.mjs";

async function update(root, args) {
  return runCli(["blog", "update", "entry", ...args, "--json"], { cwd: root });
}
async function show(root) {
  const result = await runCli(["blog", "show", "entry", "--json"], {
    cwd: root,
  });
  assert.equal(result.code, 0, result.stdout);
  return JSON.parse(result.stdout).data;
}

test("description-only update preserves exact whitespace and supports empty strings", async (t) => {
  const f = await fixture(t);
  const source = article({ extra: "author: Someone # untouched\n" });
  const path = await f.write("entry.md", source);
  const result = await update(f.root, ["--description", "  新描述  "]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.stderr, "");
  assert.equal((await show(f.root)).metadata.description, "  新描述  ");
  assert.equal(
    await readFile(path, "utf8"),
    source.replace("description: Example", 'description: "  新描述  "'),
  );
  assert.equal((await update(f.root, ["--description", ""])).code, 0);
  assert.equal((await show(f.root)).metadata.description, "");
});

test("tags replace the full ordered list, trim and deduplicate without splitting commas", async (t) => {
  const f = await fixture(t);
  await f.write("entry.md", article({ extra: "tags: [old]\n" }));
  const result = await update(f.root, [
    "--tag",
    "  TS  ",
    "--tag",
    "a,b",
    "--tag",
    "TS",
    "--tag",
    "ts",
  ]);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual((await show(f.root)).metadata.tags, ["TS", "a,b", "ts"]);
  assert.equal((await update(f.root, ["--clear-tags"])).code, 0);
  assert.deepEqual((await show(f.root)).metadata.tags, []);
});

test("metadata updates preserve BOM, CRLF, comments, inherited values and independent aliases", async (t) => {
  const f = await fixture(t);
  const source =
    "\uFEFF---\r\n# header\r\nbase: &base {title: 原始标题, description: Example, tags: [old]}\r\n<<: *base\r\npublishedAt: 2026-10-01\r\nauthor: Yoho # untouched\r\n---\r\n![图](./a.png)\r\n";
  const path = await f.write("entry.md", source);
  const result = await update(f.root, [
    "--description",
    "新描述",
    "--tag",
    "new",
  ]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(
    await readFile(path, "utf8"),
    source.replace(
      "---\r\n![图]",
      'description: "新描述"\r\ntags: ["new"]\r\n---\r\n![图]',
    ),
  );
  const block =
    "---\ntitle: 原始标题\ndescription: |- # keep description\n  Example\n\npublishedAt: 2026-10-01\ntags:\n  - old # old tag\n# outside tags\ncustom: keep\n---\nbody";
  await writeFile(path, block);
  const changed = await update(f.root, [
    "--description",
    "new\ntext",
    "--tag",
    "new",
  ]);
  assert.equal(changed.code, 0, changed.stdout);
  assert.equal((await show(f.root)).metadata.description, "new\ntext");
  assert.match(
    await readFile(path, "utf8"),
    /# keep description\n\npublishedAt/,
  );
  assert.match(
    await readFile(path, "utf8"),
    /# outside tags\ncustom: keep\n---\nbody$/,
  );
  const alias =
    "---\ntitle: 原始标题\ndescription: *description\npublishedAt: 2026-10-01\n";
  // Aliases must follow their anchor in valid YAML.
  await writeFile(
    path,
    alias.replace(
      "description: *description\n",
      "shared: &description Example\ndescription: *description\n",
    ) + "sharedTags: &tags [old]\ntags: *tags\n---\nbody",
  );
  assert.equal(
    (await update(f.root, ["--description", "new", "--tag", "new"])).code,
    0,
  );
  const shown = await show(f.root);
  assert.equal(shown.metadata.shared, "Example");
  assert.deepEqual(shown.metadata.sharedTags, ["old"]);
});

test("equivalent descriptions and ordered tags preserve version, source and modification time", async (t) => {
  const f = await fixture(t);
  const source = article({ extra: 'tags: [TS, "a,b"] # original spelling\n' });
  const path = await f.write("entry.md", source);
  const before = await stat(path, { bigint: true });
  const old = await show(f.root);
  const same = await update(f.root, [
    "--description",
    "Example",
    "--tag",
    " TS ",
    "--tag",
    "a,b",
    "--tag",
    "TS",
    "--if-match",
    old.revision,
  ]);
  assert.equal(same.code, 0, same.stdout);
  assert.deepEqual(JSON.parse(same.stdout).data, {
    id: "entry",
    title: "原始标题",
    revision: old.revision,
    changed: false,
  });
  assert.equal(await readFile(path, "utf8"), source);
  const after = await stat(path, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ino, before.ino);
  const reordered = await update(f.root, ["--tag", "a,b", "--tag", "TS"]);
  assert.equal(reordered.code, 0, reordered.stdout);
  assert.equal(JSON.parse(reordered.stdout).data.changed, true);
  assert.deepEqual((await show(f.root)).metadata.tags, ["a,b", "TS"]);
  const defaults = article();
  await writeFile(path, defaults);
  const clear = await update(f.root, ["--clear-tags"]);
  assert.equal(clear.code, 0, clear.stdout);
  assert.equal(JSON.parse(clear.stdout).data.changed, false);
  assert.equal(await readFile(path, "utf8"), defaults);
});

test("invalid inputs or linked metadata reject the entire multi-field request", async (t) => {
  const f = await fixture(t);
  const source = article({ extra: "tags: [old]\n" });
  const path = await f.write("entry.md", source);
  const input = join(f.root, "body.txt");
  await writeFile(input, "new body");
  for (const flags of [
    ["--tag", "   "],
    ["--tag", "new", "--clear-tags"],
    ["--tag", "new", "--body-file", f.root],
  ]) {
    const result = await update(f.root, [
      "--title",
      "new title",
      "--description",
      "new description",
      ...flags,
    ]);
    assert.equal(result.code, 2, result.stdout);
    assert.equal(JSON.parse(result.stdout).error.code, "INVALID_ARGUMENT");
    assert.equal(await readFile(path, "utf8"), source);
  }
  for (const linked of [
    article().replace(
      "description: Example",
      "description: &description Example\ncustom: *description",
    ),
    article({ extra: "tags: &tags [old]\ncustom: *tags\n" }),
  ]) {
    await writeFile(path, linked);
    const result = await update(f.root, [
      "--title",
      "new title",
      "--description",
      "new description",
      "--tag",
      "new",
      "--body-file",
      input,
    ]);
    assert.equal(result.code, 3, result.stdout);
    assert.equal(JSON.parse(result.stdout).error.code, "ARTICLE_INVALID");
    assert.equal(await readFile(path, "utf8"), linked);
  }
});

test("combined metadata and body updates retain version checks and target isolation", async (t) => {
  const f = await fixture(t);
  const path = await f.write(
    "entry.md",
    article({ extra: "author: Yoho\ndraft: false\n" }),
  );
  await f.write("broken.md", "---\nbroken: [\n---\n");
  const input = join(f.root, "body.txt");
  await writeFile(input, "![image](./cover.png)\nnew body");
  const before = await show(f.root);
  const result = await update(f.root, [
    "--title",
    "new title",
    "--description",
    "new description",
    "--tag",
    "new",
    "--body-file",
    input,
    "--if-match",
    before.revision,
  ]);
  assert.equal(result.code, 0, result.stdout);
  const next = await show(f.root);
  assert.equal(next.metadata.title, "new title");
  assert.equal(next.metadata.description, "new description");
  assert.deepEqual(next.metadata.tags, ["new"]);
  assert.equal(next.metadata.status, "published");
  assert.equal(next.metadata.draft, false);
  assert.equal(next.metadata.author, "Yoho");
  assert.equal(next.metadata.publishedAt, before.metadata.publishedAt);
  assert.equal(next.content, "![image](./cover.png)\nnew body");
  const bytes = await readFile(path);
  const stale = await update(f.root, [
    "--description",
    "new description",
    "--tag",
    "new",
    "--if-match",
    before.revision,
  ]);
  assert.equal(stale.code, 3, stale.stdout);
  assert.equal(JSON.parse(stale.stdout).error.code, "ARTICLE_CONFLICT");
  assert.deepEqual(await readFile(path), bytes);
});

test("same-version metadata writers have one winner and preserve the complete winning patch", async (t) => {
  const f = await fixture(t);
  await f.write("entry.md", article());
  const before = await show(f.root);
  const results = await Promise.all(
    ["first", "second"].map((value) =>
      update(f.root, [
        "--description",
        value,
        "--tag",
        value,
        "--if-match",
        before.revision,
      ]),
    ),
  );
  assert.deepEqual(results.map((result) => result.code).sort(), [0, 3]);
  assert.equal(
    JSON.parse(results.find((result) => result.code === 3).stdout).error.code,
    "ARTICLE_CONFLICT",
  );
  const winner = results[0].code === 0 ? "first" : "second";
  const next = await show(f.root);
  assert.equal(next.metadata.description, winner);
  assert.deepEqual(next.metadata.tags, [winner]);
});

test("the real blog loader reads edited descriptions, tags and body", async (t) => {
  const f = await fixture(t);
  const file = await f.write("entry.mdx", article());
  const input = join(f.root, "body.txt");
  await writeFile(input, "\n新正文。\n");
  const result = await update(f.root, [
    "--description",
    "完整描述",
    "--tag",
    "中文",
    "--tag",
    "a,b",
    "--body-file",
    input,
  ]);
  assert.equal(result.code, 0, result.stdout);
  const blogRoot = resolve(process.env.YOHO_BLOG_PROJECT ?? "../yoho-blog");
  const loader = pathToFileURL(join(blogRoot, "src/lib/content.ts")).href;
  const script = `import {readFile} from 'node:fs/promises'; const {parsePublishedBlogSources} = await import(process.argv[1]); process.stdout.write(JSON.stringify(parsePublishedBlogSources([{id:'entry',source:await readFile(process.argv[2],'utf8')}])));`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script, loader, file],
    { cwd: blogRoot, env: { ...process.env, BLOG_CONTENT_SOURCE: "local" } },
  );
  const [entry] = JSON.parse(stdout);
  assert.equal(entry.data.description, "完整描述");
  assert.deepEqual(entry.data.tags, ["中文", "a,b"]);
  assert.match(entry.body, /新正文。/);
});

test("description and tag strings preserve YAML-special Unicode line separators", async (t) => {
  const f = await fixture(t);
  await f.write("entry.md", article());
  const value = "first\u0085second\u2028third\u2029end";
  const result = await update(f.root, ["--description", value, "--tag", value]);
  assert.equal(result.code, 0, result.stdout);
  const next = await show(f.root);
  assert.equal(next.metadata.description, value);
  assert.deepEqual(next.metadata.tags, [value]);
});

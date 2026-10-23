import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

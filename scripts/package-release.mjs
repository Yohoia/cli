import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = manifest.version;
const checkOnly = process.argv[2] === "--check";
const tag =
  process.argv[checkOnly ? 3 : 2] ??
  (process.env.GITHUB_REF_TYPE === "tag"
    ? process.env.GITHUB_REF_NAME
    : undefined);

assert.equal(manifest.name, "@yohoia/cli", "Unexpected npm package name");
assert.notEqual(manifest.private, true, "Private packages cannot be released");
assert.equal(manifest.license, "MIT");
assert.equal(manifest.publishConfig?.access, "public");
assert.equal(manifest.publishConfig?.registry, "https://registry.npmjs.org/");
assert.equal(manifest.bin?.yoho, "dist/cli.js");
for (const hook of ["preinstall", "install", "postinstall"])
  assert.ok(!manifest.scripts?.[hook], `Installation must not run ${hook}`);
assert.match(
  version,
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
  "Use a release version such as 0.8.0 or 0.9.0-beta.1",
);
const prerelease = version.split("-").slice(1).join("-");
for (const identifier of prerelease.split("."))
  if (/^\d+$/u.test(identifier))
    assert.ok(
      !/^0\d/u.test(identifier),
      "Invalid numeric prerelease identifier",
    );
if (tag !== undefined)
  assert.equal(
    tag,
    `v${version}`,
    "Release tag must match package.json version",
  );
if (checkOnly) {
  process.stdout.write(`Release metadata valid: @yohoia/cli@${version}\n`);
  process.exit(0);
}

await execute(process.execPath, [join(root, "scripts/build.mjs")], {
  cwd: root,
  maxBuffer: 4_000_000,
});
const directory = join(root, "artifacts/release");
await mkdir(directory, { recursive: true });
const staging = await mkdtemp(join(tmpdir(), "yoho-pack-"));
let packed;
try {
  // Canonical permissions keep local and CI archives identical without changing source permissions.
  async function stage(path) {
    const from = join(root, path);
    const to = join(staging, path);
    const info = await lstat(from);
    assert.ok(!info.isSymbolicLink(), `Cannot release a symlink: ${path}`);
    if (info.isDirectory()) {
      await mkdir(to, { recursive: true });
      await chmod(to, 0o755);
      for (const name of await readdir(from)) await stage(join(path, name));
    } else {
      assert.ok(info.isFile(), `Not a regular release file: ${path}`);
      await mkdir(resolve(to, ".."), { recursive: true });
      await copyFile(from, to);
      await chmod(to, path === "dist/cli.js" ? 0o755 : 0o644);
    }
  }
  for (const path of [
    "dist",
    "package.json",
    "LICENSE",
    "README.md",
    "README.zh-CN.md",
    "docs/assets",
    "docs/distribution.md",
    "docs/README.md",
  ])
    await stage(path);
  const { stdout } = await execute(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
    {
      cwd: staging,
      env: { ...process.env, npm_config_cache: join(staging, ".npm-cache") },
      maxBuffer: 4_000_000,
    },
  );
  [packed] = JSON.parse(stdout);
} finally {
  await rm(staging, { recursive: true, force: true });
}
const files = new Set(packed.files.map((file) => file.path));
for (const file of [
  "dist/cli.js",
  "package.json",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "docs/distribution.md",
  "docs/assets/readme-hero.svg",
  "docs/assets/readme-hero-mobile.svg",
  "docs/assets/readme-hero-zh.svg",
  "docs/assets/readme-hero-zh-mobile.svg",
  "docs/assets/terminal-menu.png",
])
  assert.ok(files.has(file), `Missing package file: ${file}`);
assert.ok([...files].some((file) => file.startsWith("dist/chunks/")));
for (const file of files)
  assert.ok(
    /^(dist\/|docs\/assets\/|docs\/(?:distribution\.md|README\.md)$|package\.json$|LICENSE$|README(?:\.zh-CN)?\.md$)/u.test(
      file,
    ),
    `Unexpected published file: ${file}`,
  );
const filename = `yohoia-cli-${version}.tgz`;
assert.equal(packed.filename, filename);
const bytes = await readFile(join(directory, filename));
const checksum = createHash("sha256").update(bytes).digest("hex");
await writeFile(join(directory, "SHA256SUMS"), `${checksum}  ${filename}\n`);
const distTag = prerelease ? "next" : "latest";
if (process.env.GITHUB_OUTPUT)
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `filename=${filename}\nversion=${version}\ndist-tag=${distTag}\n`,
  );
process.stdout.write(
  `Prepared ${filename} (${files.size} files, npm tag: ${distTag})\nSHA256 ${checksum}\n`,
);

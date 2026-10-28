import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
assert.ok(process.argv[2], "Usage: pnpm release:verify <package.tgz>");
const tarball = resolve(process.argv[2]);
const root = await mkdtemp(join(tmpdir(), "yoho-release-"));
const prefix = join(root, "installed");
const config = join(root, "config");
const env = {
  ...process.env,
  PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
  YOHO_CONFIG_DIR: config,
  npm_config_cache: join(root, "npm-cache"),
  NO_COLOR: "1",
};
const npm = (args, cwd = root) =>
  execute(
    "npm",
    [...args, "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd, env, maxBuffer: 4_000_000 },
  );
const bin = (location) => join(location, "bin/yoho");
const run = (location, args) =>
  execute(process.execPath, [bin(location), ...args], {
    cwd: root,
    env,
    maxBuffer: 4_000_000,
  });

try {
  await mkdir(config);
  const saved = '{"server":"https://pagehush.example"}\n';
  const skills = '{"migrationSentinel":"keep-existing-skill-records"}\n';
  const skillDirectory = join(root, ".codex/skills/existing-skill");
  const skillContent = "---\nname: existing-skill\n---\nKeep this Skill.\n";
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), skillContent);
  await writeFile(join(config, "config.json"), saved);
  await writeFile(join(config, "skills.json"), skills);
  await npm(["install", "--global", "--prefix", prefix, tarball]);
  const installed = join(prefix, "lib/node_modules/@yohoia/cli");
  const manifest = JSON.parse(
    await readFile(join(installed, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "@yohoia/cli");
  assert.equal(manifest.license, "MIT");
  assert.equal(
    (await run(prefix, ["--version"])).stdout.trim(),
    manifest.version,
  );
  assert.match((await run(prefix, ["--help"])).stdout, /doctor/u);
  const { stdout: temporary } = await execute(
    "npx",
    ["--offline", "--yes", `--package=${tarball}`, "yoho", "--version"],
    { cwd: root, env, maxBuffer: 4_000_000 },
  );
  assert.equal(temporary.trim(), manifest.version);

  // Exercise a version upgrade with the same bundled CLI and an older manifest.
  const previous = join(root, "previous");
  await cp(installed, previous, { recursive: true });
  await writeFile(
    join(previous, "package.json"),
    JSON.stringify({ ...manifest, version: "0.0.0" }) + "\n",
  );
  const { stdout: previousJson } = await npm(
    ["pack", "--json", "--pack-destination", root],
    previous,
  );
  const [previousPackage] = JSON.parse(previousJson);
  const upgrade = join(root, "upgrade");
  await npm([
    "install",
    "--global",
    "--prefix",
    upgrade,
    join(root, previousPackage.filename),
  ]);
  await npm(["install", "--global", "--prefix", upgrade, tarball]);
  assert.equal(
    (await run(upgrade, ["--version"])).stdout.trim(),
    manifest.version,
  );
  assert.equal(
    JSON.parse(
      await readFile(
        join(upgrade, "lib/node_modules/@yohoia/cli/package.json"),
        "utf8",
      ),
    ).version,
    manifest.version,
  );

  // A legacy package owns the same bin. Follow the documented uninstall-first migration.
  await writeFile(
    join(previous, "package.json"),
    JSON.stringify({ ...manifest, name: "yoho-cli", version: "0.7.1" }) + "\n",
  );
  const { stdout: legacyJson } = await npm(
    ["pack", "--json", "--pack-destination", root],
    previous,
  );
  const [legacyPackage] = JSON.parse(legacyJson);
  const migration = join(root, "migration");
  await npm([
    "install",
    "--global",
    "--prefix",
    migration,
    join(root, legacyPackage.filename),
  ]);
  await npm(["uninstall", "--global", "--prefix", migration, "yoho-cli"]);
  await npm(["install", "--global", "--prefix", migration, tarball]);
  assert.equal(
    (await run(migration, ["--version"])).stdout.trim(),
    manifest.version,
  );
  await npm(["uninstall", "--global", "--prefix", migration, "@yohoia/cli"]);
  assert.equal(await readFile(join(config, "config.json"), "utf8"), saved);
  assert.equal(await readFile(join(config, "skills.json"), "utf8"), skills);
  assert.equal(
    await readFile(join(skillDirectory, "SKILL.md"), "utf8"),
    skillContent,
  );
  process.stdout.write(
    `Verified @yohoia/cli@${manifest.version}: global install, offline npx, version upgrade, legacy migration, uninstall and preserved configuration/Skills.\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

import { readdir, readFile, access } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const problems = [];
const files = [];
async function collect(directory) {
  for (const entry of await readdir(join(root, directory), {
    withFileTypes: true,
  })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else files.push(path);
  }
}
for (const directory of ["src", "tests", "scripts"]) await collect(directory);
for (const path of files) {
  const parts = path.split(/[\\/]/u);
  const name = parts.at(-1);
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.test)?\.(?:ts|tsx|mjs|py|json)$/u.test(name)
  )
    problems.push(`${path}: use lowercase kebab-case filenames`);
  if (parts[0] === "tests") {
    const test = name.endsWith(".test.mjs");
    if (
      (test && !["cli", "remote", "skills"].includes(parts[1])) ||
      (!test && parts[1] !== "helpers") ||
      parts.length !== 3
    )
      problems.push(
        `${path}: place tests by feature and support files in helpers`,
      );
  }
  if (parts[0] !== "src") continue;
  const text = await readFile(join(root, path), "utf8");
  for (const [, specifier] of text.matchAll(/from\s+["'](\.[^"']+)["']/gu)) {
    const destination = resolve(root, path, "..", specifier);
    const candidates = destination.endsWith(".js")
      ? [
          destination.replace(/\.js$/u, ".ts"),
          destination.replace(/\.js$/u, ".tsx"),
        ]
      : [destination];
    if (
      !(
        await Promise.all(
          candidates.map((candidate) =>
            access(candidate).then(
              () => true,
              () => false,
            ),
          ),
        )
      ).some(Boolean)
    )
      problems.push(`${path}: unresolved import ${specifier}`);
    const dependency = relative(root, destination).split(/[\\/]/u);
    if (dependency[0] !== "src") continue;
    const forbidden =
      (parts[1] === "core" && dependency[1] !== "core") ||
      (parts[1] === "remote" && !["remote", "core"].includes(dependency[1])) ||
      (parts[1] === "skills" && dependency[1] === "remote");
    if (forbidden)
      problems.push(`${path}: misplaced dependency on ${specifier}`);
  }
}
if (problems.length) {
  process.stderr.write(problems.join("\n") + "\n");
  process.exitCode = 1;
} else
  process.stdout.write(`Structure check passed (${files.length} files).\n`);

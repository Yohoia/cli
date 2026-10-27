import { execFileSync, spawn } from "node:child_process";

const [mode, ...args] = process.argv.slice(2);
const realGit = process.env.YOHO_TEST_REAL_GIT;
const endpoint = process.env.YOHO_TEST_CODEUP;
async function control(path) {
  const response = await fetch(endpoint + path, {
    headers: process.env.YOHO_TEST_SSH_AUTH
      ? { authorization: `Bearer ${process.env.YOHO_TEST_SSH_AUTH}` }
      : {},
  });
  if (!response.ok) {
    process.stderr.write(
      [401, 403, 404].includes(response.status)
        ? "Permission denied (publickey).\n"
        : `Codeup fixture unavailable (${response.status})\n`,
    );
    process.exit(128);
  }
  return response.json();
}
let command;
if (mode === "ssh") {
  const remote = args.find((value) => value.startsWith("git-upload-pack "));
  const match = /^git-upload-pack '([A-Za-z0-9_./-]+)\.git'$/.exec(
    remote ?? "",
  );
  if (!match || !args.includes("git@codeup.aliyun.com"))
    throw new Error("Unexpected SSH destination or command");
  const data = await control(`/transport/${match[1]}`);
  command = ["upload-pack", data.path];
} else if (mode === "git") {
  const location = args.indexOf("-C");
  const special = args.includes("archive")
    ? "archive"
    : args.includes("show")
      ? "metadata"
      : undefined;
  if (location !== -1 && special) {
    const url = execFileSync(
      realGit,
      ["-C", args[location + 1], "config", "remote.origin.url"],
      { encoding: "utf8" },
    ).trim();
    const repo = /^git@codeup\.aliyun\.com:(.+)\.git$/.exec(url)?.[1];
    const commit =
      special === "archive" ? args.at(-1) : args.at(-1).split(":")[0];
    const data = await control(`/${special}/${repo}/${commit}`);
    if (data.override !== undefined) {
      process.stdout.write(Buffer.from(data.override, "base64"));
      process.exit(0);
    }
  }
  command = args;
} else throw new Error("Unknown fixture mode");
const child = spawn(realGit, command, { stdio: "inherit" });
child.once("error", (error) => {
  throw error;
});
child.once("close", (code) => {
  process.exitCode = code ?? 1;
});

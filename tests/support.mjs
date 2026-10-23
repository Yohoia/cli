import { after } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
let installation;

async function installPackage() {
  const root = await mkdtemp(join(tmpdir(), "yoho-install-"));
  try {
    const { stdout } = await execute("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: resolve("."), maxBuffer: 4_000_000 });
    const [packed] = JSON.parse(stdout);
    const prefix = join(root, "installed");
    await execute("npm", ["install", "--prefix", prefix, "--offline", "--ignore-scripts", "--no-audit", "--no-fund", join(root, packed.filename)], { maxBuffer: 4_000_000 });
    return { root, bin: join(prefix, "node_modules", ".bin", "yoho") };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function installedCli() {
  installation ??= installPackage();
  return (await installation).bin;
}

after(async () => {
  if (installation) {
    const { root } = await installation;
    await rm(root, { recursive: true, force: true });
  }
});

export async function startCli(args, { cwd, env = {} }) {
  const bin = await installedCli();
  const child = spawn(process.execPath, [bin, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const result = new Promise((resolveResult, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI did not finish within 10 seconds"));
    }, 10_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolveResult({ code, signal, stdout, stderr });
    });
  });
  return { child, result };
}

export async function runCli(args, options) {
  return (await startCli(args, options)).result;
}

export async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "yoho-articles-")));
  const content = join(root, "content", "blog");
  await mkdir(content, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    content,
    async write(name, source) {
      const file = join(content, name);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, source);
      return file;
    },
  };
}

export function article({ title = "原始标题", status = "published", date = "2026-10-01", extra = "", body = "\n# 正文标题\n\n文章正文。\n" } = {}) {
  return `---\ntitle: ${title}\ndescription: Example\nstatus: ${status}\npublishedAt: ${date}\n${extra}---\n${body}`;
}

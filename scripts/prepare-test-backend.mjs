import { execFile, spawn } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { mkdir, mkdtemp, access, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  backendDirectory,
  backendManifest,
  verifyTestBackend,
  recordTestBackendBuild,
} from "../tests/helpers/pagehush-runtime.mjs";
const execute = promisify(execFile);
const { values } = parseArgs({
  options: {
    source: { type: "string" },
    offline: { type: "boolean", default: false },
  },
});
let present = false;
try {
  await access(backendDirectory);
  present = true;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
async function prepare(location) {
  async function npm(args) {
    await new Promise((done, reject) => {
      const child = spawn(
        process.platform === "win32" ? "npm.cmd" : "npm",
        args,
        { cwd: location, stdio: "inherit" },
      );
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0
          ? done()
          : reject(new Error(`测试后端 npm ${args[0]} 失败，退出码 ${code}`)),
      );
    });
  }
  await verifyTestBackend(location, backendManifest, { runtime: false });
  await npm([
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    ...(values.offline ? ["--offline"] : []),
  ]);
  for (const artifact of backendManifest.artifacts)
    await rm(join(location, artifact), { recursive: true, force: true });
  await npm(backendManifest.build);
  await recordTestBackendBuild(location);
  await verifyTestBackend(location);
}
if (present) {
  await verifyTestBackend(backendDirectory, backendManifest, {
    runtime: false,
  });
  try {
    await verifyTestBackend(backendDirectory);
  } catch (error) {
    if (!["ENOENT", "TEST_BACKEND_RUNTIME_INVALID"].includes(error.code))
      throw error;
    await prepare(backendDirectory);
  }
  process.stdout.write(`测试后端已准备：${backendDirectory}\n`);
} else {
  const parent = dirname(backendDirectory);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, ".prepare-"));
  const checkout = join(temporary, "checkout");
  try {
    await execute("git", [
      "clone",
      "--quiet",
      "--no-checkout",
      values.source ? resolve(values.source) : backendManifest.repository,
      checkout,
    ]);
    await execute("git", [
      "-C",
      checkout,
      "checkout",
      "--quiet",
      "--detach",
      backendManifest.revision,
    ]);
    await prepare(checkout);
    await rename(checkout, backendDirectory);
    process.stdout.write(
      `测试后端已准备：${backendDirectory}\n固定提交：${backendManifest.revision}\n`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

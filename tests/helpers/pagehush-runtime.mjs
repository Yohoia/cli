import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  readFile,
  realpath,
  lstat,
  readdir,
  mkdir,
  writeFile,
  rename,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
const execute = promisify(execFile);
const manifestSchema = z.object({
  repository: z.url(),
  revision: z.string().regex(/^[a-f0-9]{40}$/),
  lockfile: z.string().min(1),
  lockfileSha256: z.string().regex(/^[a-f0-9]{64}$/),
  entry: z.string().min(1),
  loader: z.string().min(1),
  build: z.array(z.string()).min(1),
  artifacts: z.array(z.string()).min(1),
});
export const backendManifest = manifestSchema.parse(
  JSON.parse(
    await readFile(new URL("./pagehush-backend.json", import.meta.url), "utf8"),
  ),
);
export const backendDirectory = resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
  ".cache/test-backends/pagehush",
  backendManifest.revision,
);
const buildReceipt = "node_modules/.cache/yoho-cli/backend-build.sha256";
function invalidRuntime() {
  return Object.assign(
    new Error(
      "测试后端构建校验失败；请运行 pnpm test:prepare 重新安装依赖并构建",
    ),
    {
      code: "TEST_BACKEND_RUNTIME_INVALID",
    },
  );
}
async function runtimeFingerprint(location, config) {
  const files = new Map();
  async function collect(path) {
    const full = join(location, path);
    const info = await lstat(full);
    if (info.isDirectory()) {
      files.set(path, "directory");
      for (const name of (await readdir(full)).sort())
        await collect(join(path, name));
    } else if (info.isFile()) {
      files.set(
        path,
        createHash("sha256")
          .update(await readFile(full))
          .digest("hex"),
      );
    } else throw invalidRuntime();
  }
  for (const path of [config.loader, ...config.artifacts]) await collect(path);
  return createHash("sha256")
    .update(
      JSON.stringify({
        config,
        node: process.versions.node,
        files: [...files].sort(([a], [b]) => a.localeCompare(b)),
      }),
    )
    .digest("hex");
}
export async function recordTestBackendBuild(
  source,
  manifest = backendManifest,
) {
  const config = manifestSchema.parse(manifest);
  const location = await verifyTestBackend(source, config, { runtime: false });
  const fingerprint = await runtimeFingerprint(location, config);
  const receipt = join(location, buildReceipt);
  await mkdir(dirname(receipt), { recursive: true });
  const temporary = `${receipt}.${process.pid}.tmp`;
  await writeFile(temporary, fingerprint + "\n");
  await rename(temporary, receipt);
}
export async function verifyTestBackend(
  source,
  manifest = backendManifest,
  { runtime = true } = {},
) {
  const config = manifestSchema.parse(manifest);
  const location = await realpath(source);
  const git = async (...args) =>
    (await execute("git", ["-C", location, ...args])).stdout.trim();
  if ((await realpath(await git("rev-parse", "--show-toplevel"))) !== location)
    throw new Error("测试后端路径必须是独立 Git 检出的根目录");
  const revision = await git("rev-parse", "HEAD");
  if (revision !== config.revision)
    throw new Error(
      `测试后端版本不匹配：需要 ${config.revision}，实际 ${revision}`,
    );
  if (await git("status", "--porcelain", "--untracked-files=normal"))
    throw new Error("测试后端工作树不干净；不会使用未提交文件执行验收");
  const lockfile = await readFile(join(location, config.lockfile));
  if (
    createHash("sha256").update(lockfile).digest("hex") !==
    config.lockfileSha256
  )
    throw new Error("测试后端依赖锁文件与固定版本不一致");
  await access(join(location, config.entry));
  if (runtime) {
    await access(join(location, config.loader));
    for (const artifact of config.artifacts)
      await access(join(location, artifact));
    let recorded;
    try {
      recorded = (await readFile(join(location, buildReceipt), "utf8")).trim();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      throw invalidRuntime();
    }
    if (recorded !== (await runtimeFingerprint(location, config)))
      throw invalidRuntime();
  }
  return location;
}
export async function resolveTestBackend() {
  const source = process.env.PAGEHUSH_SOURCE
    ? resolve(process.env.PAGEHUSH_SOURCE)
    : backendDirectory;
  try {
    return await verifyTestBackend(source);
  } catch (error) {
    throw new Error(
      `无法使用测试后端 ${source}：${error instanceof Error ? error.message : String(error)}。请运行 pnpm test:prepare；可用 --source /path/to/PageHush 从本地仓库准备固定提交。`,
    );
  }
}

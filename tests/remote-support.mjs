import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
const execute = promisify(execFile);
import { resolve, join } from "node:path";
import { runCli, startCli } from "./support.mjs";
export { runCli, startCli };
export async function remoteFixture(t) {
  const source = resolve(process.env.PAGEHUSH_SOURCE ?? "../PageHush");
  const root = await mkdtemp(join(tmpdir(), "yoho-remote-"));
  const keychain =
    process.platform === "darwin"
      ? join(root, "isolated.keychain-db")
      : undefined;
  if (keychain) {
    const password = randomUUID();
    await execute("/usr/bin/security", [
      "create-keychain",
      "-p",
      password,
      keychain,
    ]);
    await execute("/usr/bin/security", [
      "unlock-keychain",
      "-p",
      password,
      keychain,
    ]);
  }
  const child = spawn(
    process.execPath,
    [
      "--import",
      join(source, "node_modules/tsx/dist/loader.mjs"),
      resolve("tests/pagehush-fixture.mjs"),
    ],
    {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        NODE_ENV: "test",
        PAGEHUSH_SOURCE: source,
        PAGEHUSH_API_LOG_LEVEL: "silent",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const closed = new Promise((done) => child.once("close", done));
      child.kill("SIGTERM");
      await closed;
    }
    if (keychain)
      await execute("/usr/bin/security", ["delete-keychain", keychain]);
    await rm(root, { force: true, recursive: true });
  });
  const url = await new Promise((resolveUrl, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error(`API did not start: ${diagnostics}`)),
      20000,
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`API exited ${code}: ${diagnostics}`));
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output.split("\n").find((line) => line.startsWith('{"url"'));
      if (line) {
        clearTimeout(timer);
        resolveUrl(JSON.parse(line).url);
      }
    });
  });
  const ownerResponse = await fetch(`${url}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessCode: "test-access-code" }),
  });
  if (!ownerResponse.ok)
    throw new Error(`Test owner login failed: ${await ownerResponse.text()}`);
  const cookie = ownerResponse.headers.get("set-cookie").split(";")[0];
  async function device() {
    const code = await fetch(`${url}/v1/auth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "CLI integration" }),
    }).then((r) => r.json());
    const approval = await fetch(`${url}/v1/auth/device/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ user_code: code.user_code, decision: "approve" }),
    });
    if (!approval.ok)
      throw new Error(`Test device approval failed: ${await approval.text()}`);
    const token = await fetch(`${url}/v1/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_code: code.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    }).then((r) => r.json());
    if (!token.access_token)
      throw new Error(`Test device token failed: ${JSON.stringify(token)}`);
    return token.access_token;
  }
  return {
    root,
    url,
    cookie,
    device,
    options(token = "") {
      return {
        cwd: root,
        env: {
          YOHO_SERVER: url,
          YOHO_TOKEN: token,
          YOHO_CONFIG_DIR: join(root, "config"),
          ...(keychain ? { YOHO_KEYCHAIN: keychain } : {}),
        },
      };
    },
  };
}

export async function forwardingProxy(t, target, dropResponse = () => false) {
  const requests = [];
  const proxy = createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url });
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const headers = { ...request.headers };
      delete headers.host;
      delete headers.connection;
      delete headers["content-length"];
      const upstream = await fetch(`${target}${request.url}`, {
        method: request.method,
        headers,
        ...(body.length ? { body } : {}),
      });
      if (dropResponse(request)) {
        response.destroy();
        return;
      }
      response.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.destroy();
    }
  });
  await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
  t.after(
    () =>
      new Promise((done) => {
        proxy.closeAllConnections();
        proxy.close(done);
      }),
  );
  return { url: `http://127.0.0.1:${proxy.address().port}`, requests };
}

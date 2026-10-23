import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
const execute = promisify(execFile);
import { remoteFixture, runCli, startCli } from "./remote-support.mjs";
import { interceptingProxy } from "./intercepting-proxy.mjs";

test("installed CLI checks environment authorization without exposing or persisting its token", async (t) => {
  const api = await remoteFixture(t);
  const token = await api.device();
  const result = await runCli(["auth", "status", "--json"], api.options(token));
  assert.equal(result.code, 0, result.stderr + result.stdout);
  const state = JSON.parse(result.stdout).data;
  assert.equal(state.authenticated, true);
  assert.equal(state.server, api.url);
  assert.equal(state.source, "environment");
  assert.equal((result.stdout + result.stderr).includes(token), false);
});

test("installed CLI revokes environment authorization without writing a credential", async (t) => {
  const api = await remoteFixture(t);
  const token = await api.device();
  const result = await runCli(["auth", "logout", "--json"], {
    ...api.options(token),
    env: {
      ...api.options(token).env,
      YOHO_KEYCHAIN: "/keychain-must-not-be-read",
    },
  });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).data, {
    authenticated: false,
    server: api.url,
    revoked: true,
  });
  const session = await fetch(`${api.url}/v1/auth/device/session`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(session.status, 401);
  assert.equal((result.stdout + result.stderr).includes(token), false);
});

async function authorizationCode(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () => reject(new Error("Missing device code")),
      3000,
    );
    child.stderr.on("data", (chunk) => {
      output += chunk;
      const match = /设备授权码：([A-Z2-9]{4}-[A-Z2-9]{4})/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(`Login exited before device code: ${output}`));
    });
  });
}

async function decide(api, code, decision) {
  const response = await fetch(`${api.url}/v1/auth/device/verify`, {
    method: "POST",
    headers: { cookie: api.cookie, "content-type": "application/json" },
    body: JSON.stringify({ user_code: code, decision }),
  });
  assert.equal(response.status, 200, await response.text());
}

test("installed CLI reports denied authorization with one JSON result", async (t) => {
  const api = await remoteFixture(t);
  const { child, result } = await startCli(
    ["auth", "login", "--no-browser", "--json"],
    api.options(),
  );
  const code = await authorizationCode(child);
  await decide(api, code, "deny");
  const outcome = await result;
  assert.equal(outcome.code, 4, outcome.stderr + outcome.stdout);
  assert.equal(JSON.parse(outcome.stdout).error.code, "ACCESS_DENIED");
  assert.match(outcome.stderr, /授权地址：/);
  assert.equal(outcome.stdout.includes(code), false);
});

test(
  "installed CLI stores a browser-approved device only in an isolated keychain and logs out",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const api = await remoteFixture(t);
    const keychain = join(api.root, "isolated credentials.keychain-db");
    const password = randomBytes(16).toString("hex");
    await execute("/usr/bin/security", [
      "create-keychain",
      "-p",
      password,
      keychain,
    ]);
    try {
      await execute("/usr/bin/security", [
        "unlock-keychain",
        "-p",
        password,
        keychain,
      ]);
      const options = {
        ...api.options(),
        env: { ...api.options().env, YOHO_KEYCHAIN: keychain },
      };
      const { child, result } = await startCli(
        ["auth", "login", "--no-browser", "--json"],
        options,
      );
      await decide(api, await authorizationCode(child), "approve");
      const loggedIn = await result;
      assert.equal(loggedIn.code, 0, loggedIn.stderr + loggedIn.stdout);
      assert.equal(JSON.parse(loggedIn.stdout).data.authenticated, true);
      const { stdout } = await execute("/usr/bin/security", [
        "find-generic-password",
        "-s",
        "cn.yohoia.yoho-cli",
        "-a",
        api.url,
        "-w",
        keychain,
      ]);
      const token = stdout.trim();
      assert.match(token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal((loggedIn.stdout + loggedIn.stderr).includes(token), false);
      const status = await runCli(["auth", "status", "--json"], options);
      assert.equal(status.code, 0, status.stdout + status.stderr);
      assert.equal(JSON.parse(status.stdout).data.source, "keychain");
      const anotherServer = new URL(api.url);
      anotherServer.hostname = "localhost";
      const separate = await runCli(
        ["auth", "status", "--json", "--server", anotherServer.origin],
        options,
      );
      assert.equal(separate.code, 4);
      assert.equal(JSON.parse(separate.stdout).error.code, "AUTH_REQUIRED");
      const logout = await runCli(["auth", "logout", "--json"], options);
      assert.equal(logout.code, 0, logout.stderr + logout.stdout);
      assert.equal(
        (
          await fetch(`${api.url}/v1/auth/device/session`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
        401,
      );
      const afterLogout = await runCli(["auth", "status", "--json"], options);
      assert.equal(afterLogout.code, 4);
      assert.equal(JSON.parse(afterLogout.stdout).error.code, "AUTH_REQUIRED");
      const files = await readdir(api.root, { recursive: true });
      for (const file of files.filter(
        (file) => file.endsWith(".json") || file.endsWith(".md"),
      )) {
        assert.equal(
          (await readFile(join(api.root, file), "utf8")).includes(token),
          false,
          file,
        );
      }
    } finally {
      await execute("/usr/bin/security", ["delete-keychain", keychain]);
    }
  },
);

test("installed CLI refuses unavailable credential storage and revokes its unsaved authorization", async (t) => {
  const api = await remoteFixture(t);
  const initialFiles = await readdir(api.root);
  const options = {
    ...api.options(),
    env: {
      ...api.options().env,
      YOHO_KEYCHAIN: join(api.root, "missing.keychain-db"),
    },
  };
  const { child, result } = await startCli(
    ["auth", "login", "--no-browser", "--json"],
    options,
  );
  await decide(api, await authorizationCode(child), "approve");
  const outcome = await result;
  assert.equal(outcome.code, 4, outcome.stdout + outcome.stderr);
  assert.equal(
    JSON.parse(outcome.stdout).error.code,
    "CREDENTIAL_STORE_UNAVAILABLE",
  );
  const devices = await (
    await fetch(`${api.url}/v1/auth/devices`, {
      headers: { cookie: api.cookie },
    })
  ).json();
  assert.equal(devices.items.length, 1);
  assert.ok(devices.items[0].revokedAt);
  assert.deepEqual(await readdir(api.root), initialFiles);
});

test("installed CLI cancels device polling with one result and no stored credential", async (t) => {
  const api = await remoteFixture(t);
  const initialFiles = await readdir(api.root);
  const options = {
    ...api.options(),
    env: {
      ...api.options().env,
      YOHO_KEYCHAIN: join(api.root, "unused.keychain-db"),
    },
  };
  const { child, result } = await startCli(
    ["auth", "login", "--no-browser", "--json"],
    options,
  );
  await authorizationCode(child);
  child.kill("SIGINT");
  const cancelled = await result;
  assert.equal(cancelled.code, 130, cancelled.stderr + cancelled.stdout);
  assert.equal(JSON.parse(cancelled.stdout).error.code, "CANCELLED");
  assert.deepEqual(await readdir(api.root), initialFiles);
});

test(
  "installed CLI preserves an isolated keychain credential when revocation fails and removes it after retry",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const api = await remoteFixture(t);
    let failLogout = true;
    const proxy = await interceptingProxy(t, api.url, (request) => {
      if (request.url === "/v1/auth/device/logout" && failLogout)
        return { status: 503, body: { error: "revocation_unavailable" } };
    });
    const keychain = join(api.root, "revocation.keychain-db");
    const password = randomBytes(16).toString("hex");
    await execute("/usr/bin/security", [
      "create-keychain",
      "-p",
      password,
      keychain,
    ]);
    try {
      await execute("/usr/bin/security", [
        "unlock-keychain",
        "-p",
        password,
        keychain,
      ]);
      const options = api.options();
      options.env.YOHO_SERVER = proxy.url;
      options.env.YOHO_KEYCHAIN = keychain;
      const { child, result } = await startCli(
        ["auth", "login", "--no-browser", "--json"],
        options,
      );
      await decide(api, await authorizationCode(child), "approve");
      const loggedIn = await result;
      assert.equal(loggedIn.code, 0, loggedIn.stdout + loggedIn.stderr);
      const credential = () =>
        execute("/usr/bin/security", [
          "find-generic-password",
          "-s",
          "cn.yohoia.yoho-cli",
          "-a",
          proxy.url,
          "-w",
          keychain,
        ]).then(({ stdout }) => stdout.trim());
      const token = await credential();
      const failed = await runCli(["auth", "logout", "--json"], options);
      assert.equal(failed.code, 5, failed.stdout + failed.stderr);
      assert.equal(
        JSON.parse(failed.stdout).error.code,
        "REVOCATION_UNAVAILABLE",
      );
      assert.match(JSON.parse(failed.stdout).error.message, /保留.*凭据/);
      assert.match(JSON.parse(failed.stdout).error.message, /auth logout/);
      assert.equal(await credential(), token);
      assert.equal(
        (
          await fetch(`${api.url}/v1/auth/device/session`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
        200,
      );
      failLogout = false;
      const retried = await runCli(["auth", "logout", "--json"], options);
      assert.equal(retried.code, 0, retried.stdout + retried.stderr);
      assert.equal(JSON.parse(retried.stdout).data.revoked, true);
      await assert.rejects(credential());
      assert.equal(
        (
          await fetch(`${api.url}/v1/auth/device/session`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
        401,
      );
      assert.equal(
        proxy.requests.filter(
          (request) => request.url === "/v1/auth/device/logout",
        ).length,
        2,
      );
      assert.equal(
        (
          loggedIn.stdout +
          loggedIn.stderr +
          failed.stdout +
          failed.stderr +
          retried.stdout +
          retried.stderr
        ).includes(token),
        false,
      );
    } finally {
      await execute("/usr/bin/security", ["delete-keychain", keychain]);
    }
  },
);

async function deviceProtocolProxy(t, api, { expiresIn, poll }) {
  return interceptingProxy(t, api.url, async (request) => {
    if (request.url === "/v1/auth/device/code") {
      const issued = await fetch(`${api.url}/v1/auth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Device protocol test" }),
      });
      return {
        status: issued.status,
        body: { ...(await issued.json()), interval: 1, expires_in: expiresIn },
      };
    }
    if (request.url === "/v1/auth/device/token") return poll(request);
  });
}

test("installed CLI slows device polling after slow_down and reports server expiration without storing credentials", async (t) => {
  const api = await remoteFixture(t);
  const initialFiles = await readdir(api.root);
  let attempts = 0;
  const proxy = await deviceProtocolProxy(t, api, {
    expiresIn: 30,
    poll: () => ({
      status: 400,
      body: { error: attempts++ === 0 ? "slow_down" : "expired_token" },
    }),
  });
  const options = api.options();
  options.env.YOHO_SERVER = proxy.url;
  const result = await runCli(
    ["auth", "login", "--no-browser", "--json"],
    options,
  );
  assert.equal(result.code, 4, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, "DEVICE_AUTH_EXPIRED");
  const polls = proxy.requests.filter(
    (request) => request.url === "/v1/auth/device/token",
  );
  assert.equal(polls.length, 2);
  assert.ok(
    polls[1].at - polls[0].at >= 5_800,
    "slow_down must add five seconds to the one-second interval",
  );
  assert.deepEqual(await readdir(api.root), initialFiles);
});

test("installed CLI stops when the device-code deadline expires and stores no credential", async (t) => {
  const api = await remoteFixture(t);
  const initialFiles = await readdir(api.root);
  const proxy = await deviceProtocolProxy(t, api, {
    expiresIn: 1,
    poll: () => ({ status: 400, body: { error: "authorization_pending" } }),
  });
  const options = api.options();
  options.env.YOHO_SERVER = proxy.url;
  const result = await runCli(
    ["auth", "login", "--no-browser", "--json"],
    options,
  );
  assert.equal(result.code, 4, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error.code, "DEVICE_AUTH_EXPIRED");
  assert.equal(
    proxy.requests.filter((request) => request.url === "/v1/auth/device/token")
      .length,
    0,
  );
  assert.deepEqual(await readdir(api.root), initialFiles);
});

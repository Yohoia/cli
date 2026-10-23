import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  remoteFixture,
  forwardingProxy,
  runCli,
  startCli,
} from "./remote-support.mjs";

const execute = promisify(execFile);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=",
  "base64",
);

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

test(
  "installed CLI completes the remote lifecycle with keychain authorization, a lost create response, and source files unchanged",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const api = await remoteFixture(t);
    let droppedCreate = false;
    const proxy = await forwardingProxy(t, api.url, (request) => {
      if (
        !droppedCreate &&
        request.method === "POST" &&
        request.url === "/v1/cli/articles"
      ) {
        droppedCreate = true;
        return true;
      }
      return false;
    });
    const keychain = join(api.root, "lifecycle credentials.keychain-db");
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
      const command = async (args, expectedCode = 0) => {
        const outcome = await runCli([...args, "--json"], options);
        assert.equal(
          outcome.code,
          expectedCode,
          outcome.stdout + outcome.stderr,
        );
        const result = JSON.parse(outcome.stdout);
        assert.equal(result.ok, expectedCode === 0);
        return result;
      };
      const login = await startCli(
        ["auth", "login", "--no-browser", "--json"],
        options,
      );
      const userCode = await authorizationCode(login.child);
      const approved = await fetch(`${api.url}/v1/auth/device/verify`, {
        method: "POST",
        headers: { cookie: api.cookie, "content-type": "application/json" },
        body: JSON.stringify({ user_code: userCode, decision: "approve" }),
      });
      assert.equal(approved.status, 200, await approved.text());
      const loggedIn = await login.result;
      assert.equal(loggedIn.code, 0, loggedIn.stdout + loggedIn.stderr);
      assert.equal(JSON.parse(loggedIn.stdout).data.authenticated, true);
      assert.equal((await command(["auth", "status"])).data.source, "keychain");
      assert.deepEqual((await command(["blog", "list"])).data.items, []);

      const markdown = join(api.root, "完整生命周期.md");
      const imagePath = join(api.root, "配图.png");
      const source =
        '# 完整生命周期\n\n包含配图的正文。\n\n![配图](配图.png "保留说明")\n';
      await writeFile(markdown, source);
      await writeFile(imagePath, PNG);
      const created = (await command(["blog", "create", markdown])).data;
      assert.equal(droppedCreate, true);
      assert.equal(created.article.status, "draft");
      assert.equal(created.article.publishedAt, null);
      assert.equal(
        proxy.requests.filter(
          ({ method, url }) => method === "POST" && url === "/v1/cli/articles",
        ).length,
        1,
      );
      const shown = (await command(["blog", "show", created.article.shortId]))
        .data;
      assert.equal(shown.id, created.article.id);
      assert.equal(shown.revision, created.article.revision);
      assert.match(
        shown.content,
        /!\[配图\]\(\/v1\/assets\/[0-9a-f-]+\/content "保留说明"\)/,
      );
      const queried = (await command(["blog", "operation", created.requestId]))
        .data;
      assert.equal(queried.status, "succeeded");
      assert.equal(queried.result.article.id, shown.id);
      const resumed = (
        await command(["blog", "resume", created.requestId, markdown])
      ).data;
      assert.deepEqual(resumed, created);
      assert.equal((await command(["blog", "list"])).data.items.length, 1);

      const published = (
        await command([
          "blog",
          "publish",
          shown.id,
          "--if-match",
          shown.revision,
        ])
      ).data;
      assert.equal(published.article.status, "published");
      assert.ok(published.article.publishedAt);
      assert.notEqual(published.article.revision, shown.revision);
      const preview = (
        await command(["blog", "delete", shown.id, "--dry-run", "--yes"])
      ).data;
      assert.equal(preview.deleted, false);
      assert.equal(preview.revision, published.article.revision);
      const noConfirmation = await command(
        ["blog", "delete", shown.id, "--if-match", published.article.revision],
        2,
      );
      assert.equal(noConfirmation.error.code, "INVALID_ARGUMENT");
      const stillPresent = (await command(["blog", "show", shown.id])).data;
      assert.equal(stillPresent.revision, published.article.revision);
      const deleted = (
        await command([
          "blog",
          "delete",
          shown.id,
          "--yes",
          "--if-match",
          stillPresent.revision,
        ])
      ).data;
      assert.equal(deleted.article.id, shown.id);
      assert.deepEqual((await command(["blog", "list"])).data.items, []);
      assert.equal(
        (await command(["blog", "show", shown.id], 3)).error.code,
        "ARTICLE_NOT_FOUND",
      );
      const imageUrl = shown.content.match(
        /\/v1\/assets\/[0-9a-f-]+\/content/,
      )[0];
      const retainedImage = await fetch(`${api.url}${imageUrl}`, {
        headers: { cookie: api.cookie },
      });
      assert.equal(retainedImage.status, 200);
      assert.deepEqual(Buffer.from(await retainedImage.arrayBuffer()), PNG);

      const devices = await fetch(`${api.url}/v1/auth/devices`, {
        headers: { cookie: api.cookie },
      }).then((response) => response.json());
      assert.equal(devices.items.length, 1);
      assert.equal(devices.items[0].revokedAt, null);
      const logout = (await command(["auth", "logout"])).data;
      assert.equal(logout.revoked, true);
      const revoked = await fetch(`${api.url}/v1/auth/devices`, {
        headers: { cookie: api.cookie },
      }).then((response) => response.json());
      assert.ok(revoked.items[0].revokedAt);
      assert.equal(
        (await command(["auth", "status"], 4)).error.code,
        "AUTH_REQUIRED",
      );
      assert.equal(await readFile(markdown, "utf8"), source);
      assert.deepEqual(await readFile(imagePath), PNG);
    } finally {
      await execute("/usr/bin/security", ["delete-keychain", keychain]);
    }
  },
);

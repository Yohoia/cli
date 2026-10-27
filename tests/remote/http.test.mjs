import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { skillFixture } from "../helpers/skill-support.mjs";
import { runCli } from "../helpers/support.mjs";

test("HTTP status errors survive non-JSON bodies and malformed successful responses are protocol errors", async (t) => {
  const f = await skillFixture(t);
  let status = 401;
  let count = 0;
  let disconnect = false;
  const server = createServer((_request, response) => {
    count++;
    if (disconnect) {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.write("{");
      setTimeout(() => response.destroy(), 20);
      return;
    }
    response.writeHead(status, { "content-type": "text/html" });
    response.end("<html>Invalid response</html>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const options = {
    ...f.options,
    env: { ...f.options.env, YOHO_TOKEN: "fixture-only-token" },
  };
  for (const [nextStatus, exit, code] of [
    [401, 4, "UNAUTHORIZED"],
    [403, 4, "FORBIDDEN"],
    [200, 5, "REMOTE_PROTOCOL_ERROR"],
  ]) {
    status = nextStatus;
    count = 0;
    const out = await runCli(
      ["--server", url, "blog", "list", "--json"],
      options,
    );
    assert.equal(out.code, exit, out.stdout);
    assert.equal(JSON.parse(out.stdout).error.code, code);
    assert.equal(count, 1);
  }
  disconnect = true;
  count = 0;
  const interrupted = await runCli(
    ["--server", url, "blog", "list", "--json"],
    options,
  );
  assert.equal(interrupted.code, 5);
  assert.equal(JSON.parse(interrupted.stdout).error.code, "NETWORK_ERROR");
  assert.equal(count, 3);
});

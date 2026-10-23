import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const source = process.env.PAGEHUSH_SOURCE;
if (!source) throw new Error("Isolated PageHush checkout required");
const { buildTestServer } = await import(
  pathToFileURL(resolve(source, "packages/api/src/test-support/integration.ts"))
    .href
);
const { articles } = await import(
  pathToFileURL(resolve(source, "packages/api/src/db/schema.ts")).href
);
const server = await buildTestServer();
await server.app.database.insert(articles).values(
  [
    ["00000000-0000-4000-8000-000000000001", "2026-10-23T00:00:00Z"],
    ["00000000-0000-4000-8000-000000000002", "2026-10-22T00:00:00Z"],
    ["00000000-0000-4000-8000-000000000003", "2026-10-22T00:00:00Z"],
  ].map(([id, date]) => ({
    id,
    slug: `ordered-${id}`,
    title: `排序文章 ${id}`,
    content: "排序验收正文",
    description: "排序验收摘要",
    recordUpdatedAt: new Date(date),
  })),
);
await server.app.listen({ host: "127.0.0.1", port: 0 });
const address = server.app.server.address();
if (typeof address !== "object" || !address)
  throw new Error("Missing listener");
const login = await server.app.inject({
  method: "POST",
  url: "/v1/auth/login",
  payload: { accessCode: "test-access-code" },
});
const cookie = login.headers["set-cookie"].split(";")[0];
const code = (
  await server.app.inject({
    method: "POST",
    url: "/v1/auth/device/code",
    payload: {},
  })
).json();
await server.app.inject({
  method: "POST",
  url: "/v1/auth/device/verify",
  headers: { cookie },
  payload: { user_code: code.user_code, decision: "approve" },
});
const token = (
  await server.app.inject({
    method: "POST",
    url: "/v1/auth/device/token",
    payload: {
      device_code: code.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
  })
).json().access_token;
if (!token) throw new Error("Fixture device authorization failed");
process.stdout.write(
  `${JSON.stringify({ url: `http://127.0.0.1:${address.port}`, token })}\n`,
);
process.once("SIGTERM", async () => {
  server.app.server.closeAllConnections();
  await server.close();
  process.exit(0);
});

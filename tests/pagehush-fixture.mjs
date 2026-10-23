import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const source = process.env.PAGEHUSH_SOURCE;
if (!source)
  throw new Error(
    "PAGEHUSH_SOURCE must point to the isolated PageHush checkout",
  );
const { buildTestServer } = await import(
  pathToFileURL(resolve(source, "packages/api/src/test-support/integration.ts"))
    .href
);
const server = await buildTestServer();
await server.app.listen({ host: "127.0.0.1", port: 0 });
const address = server.app.server.address();
if (typeof address !== "object" || address === null)
  throw new Error("Missing test listener");
process.stdout.write(
  `${JSON.stringify({ url: `http://127.0.0.1:${address.port}` })}\n`,
);
const close = async () => {
  await server.close();
  process.exit(0);
};
process.once("SIGTERM", close);
process.once("SIGINT", close);

import { createServer } from "node:http";

export async function interceptingProxy(t, target, intercept) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const entry = {
      method: request.method,
      url: request.url,
      at: Date.now(),
    };
    requests.push(entry);
    try {
      const replacement = await intercept(entry, request);
      if (replacement) {
        response.writeHead(replacement.status, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify(replacement.body));
        return;
      }
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
      response.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
      });
      response.end(Buffer.from(await upstream.arrayBuffer()));
    } catch {
      response.destroy();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(
    () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      }),
  );
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

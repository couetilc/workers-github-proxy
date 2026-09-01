const { appendFileSync } = require("node:fs");
const http = require("node:http");

const port = Number.parseInt(process.env.PORT ?? "0", 10);
const auditFile = process.env.AUDIT_FILE;
if (!port || !auditFile) throw new Error("PORT and AUDIT_FILE are required");

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200).end("ok");
    return;
  }

  let bytes = 0;
  request.on("data", (chunk) => {
    bytes += chunk.length;
  });
  request.on("end", () => {
    appendFileSync(
      auditFile,
      `${JSON.stringify({
        time: new Date().toISOString(),
        method: request.method,
        path: request.url,
        requestBytes: bytes,
        responseStatus: 503,
      })}\n`,
    );
    response.writeHead(503, {
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": "1",
    });
    response.end("injected GitHub outage\n");
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`outage origin listening on ${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

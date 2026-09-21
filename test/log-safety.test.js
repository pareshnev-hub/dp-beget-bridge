import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { createLogger, requestRoute, sanitizeLogFields } from "../packages/core/src/logger.js";
import { createMcpHttpServer } from "../apps/mcp/src/server.js";

function captureLogger() {
  const lines = [];
  const stream = { write(chunk) { lines.push(String(chunk)); } };
  return { logger: createLogger("log-test", "debug", { stdout: stream, stderr: stream }), lines };
}

test("LOG-03/04: logger drops exception text and unknown nested fields", () => {
  const canary = "nested-canary-secret-value";
  const { logger, lines } = captureLogger();
  logger.error("probe.failed", {
    message: `failure includes ${canary}`,
    authorization: `Bearer ${canary}`,
    command: `printf ${canary}`,
    path: `/srv/${canary}/file.txt`,
    metadata: { refreshToken: canary },
    route: `/download/${canary}`,
    status: 500,
  });

  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], new RegExp(canary));
  const record = JSON.parse(lines[0]);
  assert.equal(record.route, "/download/[REDACTED]");
  assert.equal(record.status, 500);
  assert.equal("message" in record, false);
  assert.equal("authorization" in record, false);
  assert.equal("metadata" in record, false);
  assert.deepEqual(sanitizeLogFields({ status: 204, nested: { token: canary } }), { status: 204 });
});

test("request logs use fixed route templates", () => {
  assert.equal(requestRoute("/download/raw-grant-value"), "/download/:grant");
  assert.equal(requestRoute("/v1/sessions/private-session/commands"), "/v1/sessions/:sessionId/commands");
  assert.equal(requestRoute("/private/path/value"), "/unmatched");
  assert.equal(requestRoute("/custom-mcp", { mcpPath: "/custom-mcp" }), "/mcp");
});

test("LOG-01/02: invalid bearer and download grant never enter MCP logs", async (context) => {
  const bearerCanary = "invalid-bearer-canary-value";
  const grantCanary = "download-grant-canary-value";
  const { logger, lines } = captureLogger();
  const server = createMcpHttpServer({
    config: { accessToken: "valid-access-token-value", path: "/mcp" },
    agent: {},
    downloads: { get() { return null; } },
    logger,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const unauthorized = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { authorization: `Bearer ${bearerCanary}` },
  });
  assert.equal(unauthorized.status, 401);
  const missingDownload = await fetch(`http://127.0.0.1:${port}/download/${grantCanary}`);
  assert.equal(missingDownload.status, 404);

  const output = lines.join("");
  assert.doesNotMatch(output, new RegExp(bearerCanary));
  assert.doesNotMatch(output, new RegExp(grantCanary));
  assert.match(output, /"route":"\/mcp"/);
  assert.match(output, /"route":"\/download\/:grant"/);
});

test("LOG-05: production proxy example discards access logs", async () => {
  const caddyfile = await fs.readFile("deploy/Caddyfile.example", "utf8");
  assert.match(caddyfile, /log\s*\{[\s\S]*output discard[\s\S]*\}/);
});

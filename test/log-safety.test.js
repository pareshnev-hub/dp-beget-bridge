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
  assert.deepEqual(sanitizeLogFields({ tool: "list_files", path: `/srv/${canary}` }), { tool: "list_files" });
});

test("request logs use fixed route templates", () => {
  assert.equal(requestRoute("/download/raw-grant-value"), "/download/:grant");
  assert.equal(requestRoute("/v1/sessions/private-session/commands"), "/v1/sessions/:sessionId/commands");
  assert.equal(requestRoute("/private/path/value"), "/unmatched");
  assert.equal(requestRoute("/custom-mcp", { mcpPath: "/custom-mcp" }), "/mcp");
  assert.equal(requestRoute("/oauth/authorize"), "/oauth/authorize");
  assert.equal(requestRoute("/oauth/token"), "/oauth/token");
  assert.equal(
    requestRoute("/.well-known/oauth-protected-resource/custom-mcp", { mcpPath: "/custom-mcp" }),
    "/.well-known/oauth-protected-resource/:mcpPath",
  );
});

test("DP-017: initialize logs only sanitized client name and version", async (context) => {
  const canary = "client-info-secret\nvalue";
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

  const initialized = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer valid-access-token-value",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "ChatGPT", version: canary },
      },
    }),
  });
  assert.equal(initialized.status, 200);

  const record = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === "mcp.client_initialized");
  assert.deepEqual(record && { platform: record.platform, version: record.version }, {
    platform: "ChatGPT",
    version: "unknown",
  });
  assert.doesNotMatch(lines.join(""), /client-info-secret/);
});

test("DP-017: list_files records only the tool name", async (context) => {
  const pathCanary = "private-workspace-path-canary";
  const { logger, lines } = captureLogger();
  const server = createMcpHttpServer({
    config: { accessToken: "valid-access-token-value", path: "/mcp" },
    agent: {
      async listFiles() { return { path: "/srv/workspace", entries: [] }; },
    },
    downloads: { get() { return null; } },
    logger,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer valid-access-token-value",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_files", arguments: { path: pathCanary } },
    }),
  });
  assert.equal(response.status, 200);

  const record = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === "mcp.tool_called");
  assert.equal(record?.tool, "list_files");
  assert.doesNotMatch(lines.join(""), new RegExp(pathCanary));
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

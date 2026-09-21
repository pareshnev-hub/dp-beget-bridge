import assert from "node:assert/strict";
import test from "node:test";
import { createMcpHttpServer } from "../apps/mcp/src/server.js";
import { DownloadTokenStore } from "../apps/mcp/src/download-tokens.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const agent = {
  capabilities: async () => ({ product: "DP Beget Bridge", protocolVersion: "1.0" }),
};

test("MCP endpoint requires its configured bearer and exposes tools", async (t) => {
  const config = {
    path: "/mcp",
    publicUrl: "https://bridge.example.test",
    accessToken: "a".repeat(32),
  };
  const server = createMcpHttpServer({
    config,
    agent,
    downloads: new DownloadTokenStore({ ttlMs: 1000 }),
    logger,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/mcp`;

  const denied = await fetch(endpoint, { method: "POST" });
  assert.equal(denied.status, 401);

  const initialized = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.accessToken}`,
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
        clientInfo: { name: "test", version: "1" },
      },
    }),
  });
  assert.equal(initialized.status, 200);
  const body = await initialized.json();
  assert.equal(body.result.serverInfo.name, "dp-beget-bridge");
});

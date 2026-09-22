import assert from "node:assert/strict";
import test from "node:test";
import { AgentClient } from "../apps/mcp/src/agent-client.js";
import { createAgentServer } from "../apps/agent/src/server.js";

const staticToken = "static-agent-service-token-with-32-characters";
const oauthToken = "oauth-agent-service-token-with-32-characters";
const contextSecret = "agent-context-secret-with-more-than-32-characters";
const logger = { debug() {}, info() {}, warn() {}, error() {} };

function oauthAuthorization(ownerId, grantId, scopes) {
  return {
    kind: "oauth-spike",
    ownerId,
    grantId,
    scopes: new Set(scopes),
    executionProfile: scopes.includes("terminal:execute") ? "full-shell" : "files-read",
  };
}

test("AUTH-09: Agent rejects forged scope and isolates terminal owners", async (t) => {
  const sessionRows = [];
  const sessions = {
    async list() { return sessionRows; },
    async open() {
      const row = { id: `session-${sessionRows.length + 1}`, alive: true };
      sessionRows.push(row);
      return row;
    },
    async runCommand(id) { return { id, state: "completed" }; },
  };
  const files = {
    async list(candidate) { return { path: candidate, entries: [] }; },
    async copy() { return { copied: true }; },
  };
  const server = createAgentServer({
    config: {
      agentId: "agent-test",
      token: staticToken,
      oauthToken,
      contextSecret,
    },
    sessions,
    files,
    logger,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const readOnly = new AgentClient({
    baseUrl,
    token: oauthToken,
    contextSecret,
    authorization: oauthAuthorization("owner-primary", "grant-files-read-001", ["files:read"]),
  });
  assert.deepEqual(await readOnly.listFiles("."), { path: ".", entries: [] });
  await assert.rejects(
    readOnly.copyPath({ source: "a", destination: "b", overwrite: false }),
    { code: "forbidden_scope", status: 403 },
  );

  const unsigned = await fetch(`${baseUrl}/v1/files?path=.`, {
    headers: { authorization: `Bearer ${oauthToken}` },
  });
  assert.equal(unsigned.status, 401);

  const ownerA = new AgentClient({
    baseUrl,
    token: oauthToken,
    contextSecret,
    authorization: oauthAuthorization(
      "owner-a",
      "grant-terminal-owner-a",
      ["terminal:read", "terminal:execute"],
    ),
  });
  const ownerB = new AgentClient({
    baseUrl,
    token: oauthToken,
    contextSecret,
    authorization: oauthAuthorization(
      "owner-b",
      "grant-terminal-owner-b",
      ["terminal:read", "terminal:execute"],
    ),
  });
  const opened = await ownerA.openTerminal({});
  assert.equal((await ownerA.listSessions()).sessions.length, 1);
  assert.equal((await ownerB.listSessions()).sessions.length, 0);
  await assert.rejects(
    ownerB.runCommand(opened.id, { command: "true", idempotencyKey: "owner-isolation" }),
    { code: "session_owner_mismatch", status: 403 },
  );

  const staticClient = new AgentClient({ baseUrl, token: staticToken });
  assert.equal((await staticClient.listSessions()).sessions.length, 1);
});

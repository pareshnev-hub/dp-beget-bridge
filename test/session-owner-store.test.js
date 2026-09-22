import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgentServer } from "../apps/agent/src/server.js";
import { SessionOwnerStore } from "../apps/agent/src/session-owner-store.js";
import { AGENT_CONTEXT_HEADER, createAgentContext } from "../packages/auth/src/agent-context.js";

const contextSecret = "agent-context-secret-with-more-than-32-characters";
const oauthToken = "oauth-agent-token-with-more-than-32-characters";
const authorization = {
  ownerId: "owner-primary",
  grantId: "grant-terminal-001",
  scopes: new Set(["terminal:read", "terminal:execute"]),
  executionProfile: "full-shell",
};

function context(method, requestPath) {
  return createAgentContext({
    secret: contextSecret,
    authorization,
    method,
    path: requestPath,
  });
}

async function request(origin, method, requestPath, body) {
  return fetch(`${origin}${requestPath}`, {
    method,
    headers: {
      authorization: `Bearer ${oauthToken}`,
      [AGENT_CONTEXT_HEADER]: context(method, requestPath),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function listen(sessionOwners, sessions) {
  const server = createAgentServer({
    config: {
      token: "static-agent-token-with-more-than-32-characters",
      oauthToken,
      contextSecret,
      agentId: "test-agent",
    },
    sessions,
    files: {},
    sessionOwners,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("DP-018 OAuth terminal ownership survives Agent restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-session-owners-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const sessions = {
    async open() { return { id: "session-persistent", alive: true }; },
    async list() { return [{ id: "session-persistent", alive: true }]; },
    async close() { return { id: "session-persistent", state: "CLOSED" }; },
    async purge() { return { id: "session-persistent", purged: true }; },
  };

  const firstStore = new SessionOwnerStore(dataDir);
  await firstStore.init();
  let runtime = await listen(firstStore, sessions);
  const opened = await request(runtime.origin, "POST", "/v1/sessions", { cwd: "." });
  assert.equal(opened.status, 201);
  await runtime.close();
  firstStore.close();

  const secondStore = new SessionOwnerStore(dataDir);
  await secondStore.init();
  runtime = await listen(secondStore, sessions);
  const listed = await request(runtime.origin, "GET", "/v1/sessions");
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).sessions, [{ id: "session-persistent", alive: true }]);

  const mode = (await fs.stat(path.join(dataDir, "session-owners.sqlite"))).mode & 0o777;
  assert.equal(mode, 0o600);
  await runtime.close();
  secondStore.close();
});

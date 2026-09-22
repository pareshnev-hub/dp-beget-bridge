import assert from "node:assert/strict";
import test from "node:test";
import { createAgentContext, verifyAgentContext } from "../packages/auth/src/agent-context.js";

const secret = "agent-context-secret-with-more-than-32-characters";
const authorization = {
  ownerId: "owner-primary",
  grantId: "grant-read-only-001",
  scopes: new Set(["files:read"]),
  executionProfile: "files-read",
};

test("AUTH-09: signed Agent context binds owner, grant, scopes, method, path and expiry", () => {
  const now = Date.parse("2026-09-22T21:00:00.000Z");
  const value = createAgentContext({
    secret,
    authorization,
    method: "GET",
    path: "/v1/files?path=.",
    now,
  });
  const verified = verifyAgentContext({
    secret,
    value,
    method: "GET",
    path: "/v1/files?path=.",
    now: now + 1_000,
  });
  assert.equal(verified.ownerId, authorization.ownerId);
  assert.equal(verified.grantId, authorization.grantId);
  assert.equal(verified.executionProfile, authorization.executionProfile);
  assert.deepEqual([...verified.scopes], ["files:read"]);

  assert.throws(
    () => verifyAgentContext({
      secret,
      value,
      method: "DELETE",
      path: "/v1/files?path=.",
      now: now + 1_000,
    }),
    { name: "AgentContextError", code: "agent_context_mismatch" },
  );
  assert.throws(
    () => verifyAgentContext({
      secret,
      value: `${value.slice(0, -1)}x`,
      method: "GET",
      path: "/v1/files?path=.",
      now: now + 1_000,
    }),
    { name: "AgentContextError", code: "invalid_agent_context" },
  );
  assert.throws(
    () => verifyAgentContext({
      secret,
      value,
      method: "GET",
      path: "/v1/files?path=.",
      now: now + 31_000,
    }),
    { name: "AgentContextError", code: "expired_agent_context" },
  );
});

test("AUTH-09: model-supplied fields cannot create a context without server authorization", () => {
  assert.throws(
    () => createAgentContext({
      secret,
      authorization: {
        confirmed: true,
        ownerId: "owner-primary",
        scopes: new Set(["files:read"]),
        executionProfile: "files-read",
      },
      method: "GET",
      path: "/v1/files",
    }),
    { name: "AgentContextError", code: "invalid_agent_context" },
  );
});

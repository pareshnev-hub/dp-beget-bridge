import assert from "node:assert/strict";

const baseUrl = (process.env.DP_AGENT_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.DP_AGENT_TOKEN;
const maxActive = Number(process.env.DP_TERMINAL_MAX_ACTIVE || 8);
const requestTimeoutMs = Number(process.env.DP_SESSION_CAP_SMOKE_TIMEOUT_MS || 15000);

if (!token) throw new Error("DP_AGENT_TOKEN is required");
if (!Number.isSafeInteger(maxActive) || maxActive < 1 || maxActive > 64) {
  throw new Error("DP_TERMINAL_MAX_ACTIVE must be an integer between 1 and 64");
}
if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 120000) {
  throw new Error("DP_SESSION_CAP_SMOKE_TIMEOUT_MS must be between 1000 and 120000");
}

async function request(method, pathname, body = undefined) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch {}
  return { status: response.status, payload };
}

function sessionState(sessions) {
  return sessions
    .map(({ id, alive, closedAt }) => ({ id, alive, closedAt: closedAt ?? null }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

async function listSessions() {
  const result = await request("GET", "/v1/sessions");
  assert.equal(result.status, 200, `Session listing returned HTTP ${result.status}`);
  assert.ok(Array.isArray(result.payload.sessions), "Session listing omitted sessions array");
  return result.payload.sessions;
}

const before = await listSessions();
const beforeState = sessionState(before);
const preExistingActive = before.filter((session) => session.alive && !session.closedAt).length;
const available = Math.max(0, maxActive - preExistingActive);
const createdIds = [];
const cleanupErrors = [];
let primaryError;
let rejectedCount = 0;

try {
  const attempts = await Promise.all(Array.from({ length: available + 1 }, () => (
    request("POST", "/v1/sessions", { cwd: ".", label: "DP-016 live cap smoke" })
  )));

  const created = attempts.filter((attempt) => attempt.status === 201);
  const rejected = attempts.filter((attempt) => (
    attempt.status === 429 && attempt.payload?.error?.code === "session_limit"
  ));
  const unexpected = attempts.filter((attempt) => (
    attempt.status !== 201
    && !(attempt.status === 429 && attempt.payload?.error?.code === "session_limit")
  ));

  for (const attempt of created) {
    assert.match(attempt.payload?.id || "", /^[a-zA-Z0-9_-]{1,80}$/, "Created session omitted a safe ID");
    createdIds.push(attempt.payload.id);
  }
  rejectedCount = rejected.length;

  assert.equal(unexpected.length, 0, `Unexpected admission responses: ${JSON.stringify(
    unexpected.map((attempt) => ({ status: attempt.status, code: attempt.payload?.error?.code || null })),
  )}`);
  assert.equal(created.length, available, "Concurrent admission did not fill exactly the available slots");
  assert.equal(rejected.length, 1, "Concurrent admission did not return exactly one session_limit rejection");
} catch (error) {
  primaryError = error;
} finally {
  await Promise.all(createdIds.map(async (id) => {
    const encoded = encodeURIComponent(id);
    try {
      const closed = await request("DELETE", `/v1/sessions/${encoded}`);
      if (closed.status !== 200 && closed.status !== 404) {
        throw new Error(`close HTTP ${closed.status}`);
      }
      const purged = await request("DELETE", `/v1/sessions/${encoded}/purge`);
      if (purged.status !== 200 && purged.status !== 404) {
        throw new Error(`purge HTTP ${purged.status}`);
      }
    } catch (error) {
      cleanupErrors.push({ id, error: error.message });
    }
  }));
}

let afterState;
try {
  afterState = sessionState(await listSessions());
} catch (error) {
  primaryError ||= error;
}

if (!primaryError && cleanupErrors.length === 0) {
  try {
    assert.deepEqual(afterState, beforeState, "Smoke cleanup did not restore the pre-existing session state");
  } catch (error) {
    primaryError = error;
  }
}

if (primaryError || cleanupErrors.length > 0) {
  const diagnostics = {
    result: "fail",
    endpoint: baseUrl,
    maxActive,
    preExisting: before.length,
    preExistingActive,
    attempted: available + 1,
    created: createdIds.length,
    rejected: rejectedCount,
    cleanupErrors: cleanupErrors.length,
    reason: primaryError?.message || "session cleanup failed",
  };
  throw new Error(`DP-016 live session-cap smoke failed: ${JSON.stringify(diagnostics)}`);
}

console.log(JSON.stringify({
  result: "pass",
  endpoint: baseUrl,
  maxActive,
  preExisting: before.length,
  preExistingActive,
  created: createdIds.length,
  rejected: "session_limit",
  cleanup: "pass",
}));

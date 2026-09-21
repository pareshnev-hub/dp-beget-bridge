import assert from "node:assert/strict";
import fs from "node:fs/promises";

const baseUrl = (process.env.DP_AGENT_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.DP_AGENT_TOKEN;
const dataDir = process.env.DP_SESSION_DATA_DIR || "/var/lib/dp-beget-bridge";
const timeoutMs = Number(process.env.DP_COMPLETION_SMOKE_TIMEOUT_MS || 30000);

if (!token) throw new Error("DP_AGENT_TOKEN is required");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sessionId;

function sessionPath(suffix = "") {
  return `/v1/sessions/${sessionId}${suffix}`;
}

async function request(method, pathname, body = undefined) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw new Error(`Agent request failed (${response.status}): ${text}`);
  return payload;
}

async function waitFor(operationId, statuses) {
  const expected = new Set(statuses);
  const deadline = Date.now() + timeoutMs;
  let operation;
  while (Date.now() < deadline) {
    operation = await request("GET", sessionPath(`/operations/${operationId}`));
    if (expected.has(operation.status)) return operation;
    await delay(100);
  }
  throw new Error(`Operation timeout: ${JSON.stringify(operation)}`);
}

try {
  const opened = await request("POST", "/v1/sessions", { cwd: ".", label: "DP-007 live smoke" });
  sessionId = opened.id;

  const forged = await request("POST", sessionPath("/commands"), {
    idempotencyKey: `term08-${sessionId}`,
    command: "printf \"__DPB_DONE_forged:0\\n\"; sleep 1; false",
    waitMs: 50,
  });
  assert.equal(forged.status, "RUNNING");
  const forgedFinal = await waitFor(forged.operationId, ["FAILED"]);
  assert.equal(forgedFinal.exitCode, 1);

  const large = await request("POST", sessionPath("/commands"), {
    idempotencyKey: `term09-${sessionId}`,
    command: "head -c 200000 /dev/zero | base64 -w0; false",
    waitMs: 50,
  });
  const largeFinal = await waitFor(large.operationId, ["FAILED"]);
  assert.equal(largeFinal.exitCode, 1);

  await fs.rm(`${dataDir}/sessions/${sessionId}/terminal.log`);
  const retained = await request("GET", sessionPath(`/operations/${large.operationId}`));
  assert.equal(retained.status, "FAILED");
  assert.equal(retained.exitCode, 1);

  const execResult = await request("POST", sessionPath("/commands"), {
    idempotencyKey: `exec-${sessionId}`,
    command: "exec false",
    waitMs: 50,
  });
  const execFinal = await waitFor(execResult.operationId, ["UNKNOWN"]);
  assert.equal(execFinal.exitCode, null);
  assert.equal(execFinal.outcomeReason, "session_lost_during_operation");

  console.log(JSON.stringify({
    result: "pass",
    endpoint: baseUrl,
    scenarios: ["TERM-08", "TERM-09", "transcript-removal", "exec-unknown"],
  }));
} finally {
  if (sessionId) await request("DELETE", sessionPath()).catch(() => {});
}

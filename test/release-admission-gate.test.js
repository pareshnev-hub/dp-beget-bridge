import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentServer } from "../apps/agent/src/server.js";
import { createMcpHttpServer } from "../apps/mcp/src/server.js";
import { createSessionHostServer } from "../apps/session-host/src/server.js";
import { isAdmissionPaused } from "../packages/core/src/admission-gate.js";
import { pauseAdmission, resumeAdmission } from "../scripts/release/admission-pause.mjs";
import { localReleaseHealthProbes, waitForAdmissionDrain } from "../scripts/release/wait-admission-drain.mjs";

const logger = { error() {}, debug() {} };

async function request(server, pathname, headers = {}) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    return await fetch(`http://127.0.0.1:${address.port}${pathname}`, { headers });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("OPS-07: maintenance flag blocks OAuth/MCP, Agent and Session Host admissions but leaves health available", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const admissionPausePath = path.join(root, "admission-paused");
  let called = 0;
  const sessions = { list: async () => { called++; return []; } };
  const agentConfig = { admissionPausePath, token: "t".repeat(32), agentId: "test" };
  const mcpConfig = { admissionPausePath, path: "/mcp", accessToken: "m".repeat(32), authMode: "static" };
  const servers = [
    { server: createAgentServer({ config: agentConfig, sessions, files: {}, logger }), path: "/v1/sessions",
      headers: { authorization: `Bearer ${agentConfig.token}` } },
    { server: createMcpHttpServer({ config: mcpConfig, agent: {}, downloads: {}, logger }), path: "/mcp",
      headers: { authorization: `Bearer ${mcpConfig.accessToken}` } },
    { server: createSessionHostServer({ sessions, logger, admissionPausePath }), path: "/v1/sessions" },
  ];
  await writeFile(admissionPausePath, "paused\n");
  for (const item of servers) {
    const refused = await request(item.server, item.path, item.headers);
    assert.equal(refused.status, 503);
    assert.equal((await refused.json()).error.code, "admission_paused");
    const health = await request(item.server, "/health");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).admission, "paused");
  }
  assert.equal(called, 0);
  await rm(admissionPausePath);
  assert.equal((await request(servers[0].server, "/v1/sessions", servers[0].headers)).status, 200);
  assert.equal((await request(servers[2].server, "/v1/sessions")).status, 200);
  assert.equal(called, 2);
});

test("OPS-07: health cannot claim a drained service while an earlier request is still active", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-drain-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const flag = path.join(root, "admission-paused");
  let markStarted;
  let release;
  const started = new Promise(resolve => { markStarted = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const server = createAgentServer({ config: { admissionPausePath: flag, token: "a".repeat(32), agentId: "drain" },
    sessions: { list: async () => { markStarted(); await pending; return []; } }, files: {}, logger });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const previous = fetch(`${url}/v1/sessions`, { headers: { authorization: `Bearer ${"a".repeat(32)}` } });
  await started;
  await writeFile(flag, "paused");
  const probe = async () => (await fetch(`${url}/health`)).json();
  const busy = await probe();
  assert.equal(busy.inFlightRequests, 1);
  assert.equal(busy.admission, "paused");
  await assert.rejects(waitForAdmissionDrain({ probes: [probe], timeoutMs: 50, intervalMs: 5 }), /not proven/);
  release();
  assert.equal((await previous).status, 200);
  assert.deepEqual(await waitForAdmissionDrain({ probes: [probe] }), { drained: true, services: 1 });
  await assert.rejects(waitForAdmissionDrain({ probes: [async () => new Promise(() => {})],
    timeoutMs: 20, intervalMs: 5 }), /not proven/);
  assert.throws(() => localReleaseHealthProbes({ sessionSocket: "relative/socket" }), /absolute/);
  assert.throws(() => localReleaseHealthProbes({ agentPort: 8788, mcpPort: 8788 }), /distinct/);
});

test("OPS-07: malformed, linked and unreadable maintenance paths fail closed", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-admission-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const flag = path.join(root, "pause");
  assert.equal(await isAdmissionPaused(flag), false);
  await symlink("/etc/passwd", flag);
  assert.equal(await isAdmissionPaused(flag), true);
  assert.equal(await isAdmissionPaused("relative/flag"), true);
});

test("OPS-07: root-only pause persists through failed readiness and resumes after health proof", {
  skip: process.getuid?.() !== 0
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-managed-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o755);
  const flag = path.join(root, "maintenance", "admission-paused");
  assert.deepEqual(await pauseAdmission({ flag }), { paused: true, existing: false });
  assert.equal((await stat(flag)).mode & 0o777, 0o644);
  assert.deepEqual(await pauseAdmission({ flag }), { paused: true, existing: true });
  await assert.rejects(resumeAdmission({ flag, assertHealthy: async () => { throw new Error("unhealthy"); } }), /unhealthy/);
  assert.equal(await isAdmissionPaused(flag), true);
  let called = 0;
  assert.deepEqual(await resumeAdmission({ flag, assertHealthy: async () => { called++; } }), { paused: false });
  assert.equal(called, 1);
  assert.equal(await isAdmissionPaused(flag), false);
  await symlink("/etc/passwd", flag);
  await assert.rejects(pauseAdmission({ flag }), /root-owned regular file/);
  assert.equal(await isAdmissionPaused(flag), true);
});

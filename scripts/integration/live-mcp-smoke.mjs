import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const execFileAsync = promisify(execFile);

const endpoint = new URL(process.env.DP_MCP_SMOKE_URL || "http://127.0.0.1:8788/mcp");
const accessToken = process.env.DP_MCP_ACCESS_TOKEN || "";
const reconnectDelayMs = Number.parseInt(process.env.DP_MCP_SMOKE_RECONNECT_DELAY_MS || "2500", 10);
const restartSystemd = /^(1|true|yes)$/i.test(process.env.DP_MCP_SMOKE_RESTART_SYSTEMD || "false");

if (accessToken.length < 32) {
  throw new Error("DP_MCP_ACCESS_TOKEN must be loaded before running the live MCP smoke test");
}
if (restartSystemd && process.getuid?.() !== 0) {
  throw new Error("DP_MCP_SMOKE_RESTART_SYSTEMD requires root");
}

let client;
let sessionId;
const cleanupSessionIds = new Set();

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connect() {
  const nextClient = new Client({ name: "dpb-live-mcp-smoke", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
  });
  await nextClient.connect(transport);
  return nextClient;
}

async function connectWithRetry() {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await connect();
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError || new Error("MCP reconnect timed out");
}

async function disconnect() {
  if (!client) return;
  await client.close().catch(() => {});
  client = undefined;
}

async function callTool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
}

async function commandOutput(command, args) {
  const { stdout } = await execFileAsync(command, args, { encoding: "utf8" });
  return stdout.trim();
}

async function waitForHealth(url) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Health timeout for ${url}: ${lastError?.message || "unknown error"}`);
}

async function waitForSessionHost() {
  const socketPath = process.env.DP_SESSION_HOST_SOCKET || "/run/dp-beget-bridge/session-host.sock";
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const request = http.get({ socketPath, path: "/health" }, (response) => {
          response.resume();
          response.on("end", () => response.statusCode === 200
            ? resolve()
            : reject(new Error(`HTTP ${response.statusCode}`)));
        });
        request.on("error", reject);
      });
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`Session Host readiness timeout: ${lastError?.code || lastError?.message || "unknown error"}`);
}

async function canReadAs(user, file) {
  try {
    await execFileAsync("runuser", ["-u", user, "--", "test", "-r", file]);
    return true;
  } catch {
    return false;
  }
}

async function verifySeparatedRuntime() {
  const units = {
    mcp: "dp-beget-mcp.service",
    agent: "dp-beget-agent.service",
    work: "dp-beget-session-host.service",
  };
  const identities = {};
  for (const [role, unit] of Object.entries(units)) {
    identities[role] = await commandOutput("systemctl", ["show", unit, "--property=User", "--value"]);
  }
  assert.equal(new Set(Object.values(identities)).size, 3, "MCP, Agent, and work identities must be distinct");
  assert.equal(Object.values(identities).includes("root"), false, "normal runtime identities must not be root");
  assert.equal(await canReadAs(identities.work, "/etc/dp-beget-bridge/agent.env"), false);
  assert.equal(await canReadAs(identities.work, "/etc/dp-beget-bridge/mcp.env"), false);
  assert.equal(await canReadAs(identities.work, "/etc/dp-beget-bridge/bridge.env"), false);
  assert.equal(await canReadAs(identities.agent, "/etc/dp-beget-bridge/mcp.env"), false);
  assert.equal(await canReadAs(identities.mcp, "/etc/dp-beget-bridge/agent.env"), false);

  const sessionHostPid = await commandOutput(
    "systemctl",
    ["show", units.work, "--property=MainPID", "--value"],
  );
  assert.match(sessionHostPid, /^[1-9]\d*$/);
  const environment = (await fs.readFile(`/proc/${sessionHostPid}/environ`))
    .toString("utf8")
    .split("\0");
  assert.equal(environment.some((entry) => entry.startsWith("DP_AGENT_TOKEN=")), false);
  assert.equal(environment.some((entry) => entry.startsWith("DP_MCP_ACCESS_TOKEN=")), false);
  return identities;
}

async function waitForOutput(expected) {
  const deadline = Date.now() + 15000;
  let last = "";
  while (Date.now() < deadline) {
    const result = await callTool("read_terminal", {
      session_id: sessionId,
      cursor: 0,
      max_bytes: 262144,
    });
    last = result.output;
    if (last.includes(expected)) return last;
    await delay(100);
  }
  throw new Error(`Timed out waiting for synthetic output: ${expected}\n${last}`);
}

try {
  client = await connect();
  const opened = await callTool("open_terminal", { cwd: ".", label: "Beget live MCP smoke" });
  sessionId = opened.id;
  cleanupSessionIds.add(sessionId);

  const command = await callTool("run_terminal_command", {
    session_id: sessionId,
    idempotency_key: `live-phase-${sessionId}`,
    command: "printf '\\142\\145\\147\\145\\164\\055\\160\\150\\141\\163\\145\\055\\157\\156\\145\\012'; sleep " + (restartSystemd ? "12" : "2") + "; printf '\\142\\145\\147\\145\\164\\055\\160\\150\\141\\163\\145\\055\\164\\167\\157\\012'",
    wait_ms: 50,
  });
  assert.equal(command.state, "running", "short wait must not terminate or falsely complete the command");

  await disconnect();
  let identities;
  if (restartSystemd) {
    await execFileAsync("systemctl", ["restart", "dp-beget-mcp.service"]);
    await waitForHealth(`${endpoint.origin}/health`);
    await execFileAsync("systemctl", ["restart", "dp-beget-agent.service"]);
    await waitForHealth(process.env.DP_AGENT_URL
      ? `${process.env.DP_AGENT_URL.replace(/\/$/, "")}/health`
      : "http://127.0.0.1:8787/health");
    await waitForHealth(`${endpoint.origin}/health`);
    await execFileAsync("systemctl", ["restart", "dp-beget-session-host.service"]);
    await waitForSessionHost();
    identities = await verifySeparatedRuntime();
  } else {
    await delay(reconnectDelayMs);
  }
  client = await connectWithRetry();

  const listed = await callTool("list_terminal_sessions");
  assert.equal(
    listed.sessions.find((session) => session.id === sessionId)?.alive,
    true,
    "the terminal must remain alive after MCP client disconnect",
  );

  const continued = await waitForOutput("beget-phase-two");
  assert.match(continued, /beget-phase-one/);

  if (restartSystemd) {
    const uncertain = await callTool("get_terminal_operation", {
      session_id: sessionId,
      operation_id: command.operationId,
    });
    assert.equal(uncertain.status, "UNKNOWN", "Session Host restart must expose crash ambiguity honestly");
    await callTool("interrupt_terminal", { session_id: sessionId });
  }

  await callTool("send_terminal_input", {
    session_id: sessionId,
    input: "printf '\\142\\145\\147\\145\\164\\055\\151\\156\\164\\145\\162\\141\\143\\164\\151\\166\\145\\055\\157\\153\\012'",
    enter: true,
  });
  await waitForOutput("beget-interactive-ok");

  const guard = await callTool("open_terminal", { cwd: ".", label: "Beget close isolation guard" });
  cleanupSessionIds.add(guard.id);

  const interruptTarget = await callTool("run_terminal_command", {
    session_id: sessionId,
    idempotency_key: `live-interrupt-${sessionId}`,
    command: "sleep 30",
    wait_ms: 50,
  });
  assert.equal(interruptTarget.state, "running");
  await callTool("interrupt_terminal", { session_id: sessionId });
  await delay(250);
  const afterInterrupt = await callTool("list_terminal_sessions");
  assert.equal(afterInterrupt.sessions.find((session) => session.id === guard.id)?.alive, true);
  const usableAfterInterrupt = await callTool("run_terminal_command", {
    session_id: sessionId,
    idempotency_key: `live-after-interrupt-${sessionId}`,
    command: "printf '\\142\\145\\147\\145\\164\\055\\160\\157\\163\\164\\055\\151\\156\\164\\145\\162\\162\\165\\160\\164\\055\\157\\153\\012'",
    wait_ms: 5000,
  });
  assert.equal(usableAfterInterrupt.state, "completed");

  await callTool("close_terminal", { session_id: sessionId });
  const afterClose = await callTool("list_terminal_sessions");
  assert.equal(
    afterClose.sessions.find((session) => session.id === guard.id)?.alive,
    true,
    "closing the selected terminal must not close another live session",
  );
  const retained = afterClose.sessions.find((session) => session.id === sessionId);
  assert.equal(retained?.state, "CLOSED");
  assert.equal(retained?.alive, false);
  if (restartSystemd) {
    await execFileAsync("systemctl", ["restart", "dp-beget-session-host.service"]);
    await waitForSessionHost();
    const archived = await callTool("read_terminal", {
      session_id: sessionId,
      cursor: 0,
      max_bytes: 262144,
    });
    assert.equal(archived.state, "CLOSED");
    assert.match(archived.output, /beget-post-interrupt-ok/);
    assert.match(archived.cursor, /^v1:/);
  }
  await callTool("purge_terminal", { session_id: sessionId });
  cleanupSessionIds.delete(sessionId);
  sessionId = undefined;
  await callTool("close_terminal", { session_id: guard.id });
  await callTool("purge_terminal", { session_id: guard.id });
  cleanupSessionIds.delete(guard.id);

  const osRelease = await commandOutput("sh", ["-c", ". /etc/os-release; printf '%s' \"${PRETTY_NAME:-unknown}\""]);

  console.log(JSON.stringify({
    result: "pass",
    commit: await commandOutput("git", ["rev-parse", "HEAD"]),
    endpoint: `${endpoint.origin}${endpoint.pathname}`,
    node: process.version,
    os: `${osRelease} ${os.arch()}`,
    systemd: (await commandOutput("systemctl", ["--version"])).split("\n")[0],
    tmux: await commandOutput("tmux", ["-V"]),
    profile: {
      endpointHost: endpoint.hostname,
      telemetryEnabled: /^(1|true|yes)$/i.test(process.env.DP_TELEMETRY_ENABLED || "false"),
      identities,
    },
    scenarios: ["TERM-01", "TERM-10", "TERM-11", "TERM-12", ...(restartSystemd ? ["TERM-02", "TERM-03", "TERM-07", "CUR-03"] : [])],
    supplemental: {
      clientDisconnectReconnect: "pass",
      serviceRestartCoveredHere: restartSystemd,
      credentialAcl: restartSystemd ? "pass" : "not-run",
    },
  }));
} finally {
  if (cleanupSessionIds.size > 0) {
    if (!client) client = await connect().catch(() => undefined);
    if (client) {
      for (const id of cleanupSessionIds) {
        await callTool("close_terminal", { session_id: id }).catch(() => {});
        await callTool("purge_terminal", { session_id: id }).catch(() => {});
      }
    }
  }
  await disconnect();
}

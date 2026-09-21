import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { SessionHostClient } from "../../apps/agent/src/session-host-client.js";

const execFileAsync = promisify(execFile);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-tmux-integration-"));
const workspace = path.join(root, "workspace");
const agentDataDir = path.join(root, "agent-data");
const sessionDataDir = path.join(root, "session-data");
const sessionHostSocket = path.join(root, "run", "session-host.sock");
const tmuxSocket = path.join(sessionDataDir, "tmux", "tmux.sock");
const port = 18000 + (process.pid % 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const token = "integration-agent-token-that-is-not-a-production-secret";
const agentEnvironment = {
  ...process.env,
  DP_AGENT_HOST: "127.0.0.1",
  DP_AGENT_PORT: String(port),
  DP_AGENT_TOKEN: token,
  DP_DATA_DIR: agentDataDir,
  DP_SESSION_HOST_SOCKET: sessionHostSocket,
  DP_ALLOWED_ROOTS: workspace,
  DP_FILE_UPLOAD_MAX_BYTES: String(4 * 1024 * 1024),
  DP_TELEMETRY_ENABLED: "false",
  DP_LOG_LEVEL: "info",
};
const {
  DP_AGENT_TOKEN: _agentToken,
  DP_MCP_ACCESS_TOKEN: _mcpToken,
  ...credentialFreeEnvironment
} = process.env;
const sessionHostEnvironment = {
  ...credentialFreeEnvironment,
  DP_SESSION_HOST_SOCKET: sessionHostSocket,
  DP_SESSION_DATA_DIR: sessionDataDir,
  DP_ALLOWED_ROOTS: workspace,
  DP_TMUX_SOCKET: tmuxSocket,
  DP_COMMAND_WAIT_MS: "50",
  DP_TERMINAL_HISTORY_LINES: "10000",
  DP_SESSION_OUTPUT_WARN_BYTES: String(4 * 1024 * 1024),
  DP_LOG_LEVEL: "info",
};

let agent;
let sessionHost;
let sessionId;
let agentLogs = "";
let sessionHostLogs = "";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(pathname, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const payload = text.length === 0 ? {} : JSON.parse(text);
  if (!response.ok) {
    throw new Error(`Agent request failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function waitForAgent() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (agent.exitCode !== null) throw new Error(`Agent exited early (${agent.exitCode})\n${agentLogs}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Startup connection errors are expected until listen() completes.
    }
    await delay(100);
  }
  throw new Error(`Agent health timeout\n${agentLogs}`);
}

async function waitForSessionHost() {
  const deadline = Date.now() + 10000;
  const client = new SessionHostClient({ socketPath: sessionHostSocket });
  while (Date.now() < deadline) {
    if (sessionHost.exitCode !== null) {
      throw new Error(`Session Host exited early (${sessionHost.exitCode})\n${sessionHostLogs}`);
    }
    try {
      const health = await client.request("/health");
      if (health.status === "ok") return;
    } catch {
      // Socket startup errors are expected until listen() completes.
    }
    await delay(100);
  }
  throw new Error(`Session Host health timeout\n${sessionHostLogs}`);
}

async function startSessionHost() {
  sessionHost = spawn(process.execPath, ["apps/session-host/src/index.js"], {
    cwd: process.cwd(),
    env: sessionHostEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  sessionHost.stdout.on("data", (chunk) => { sessionHostLogs += chunk; });
  sessionHost.stderr.on("data", (chunk) => { sessionHostLogs += chunk; });
  await waitForSessionHost();
}

async function startAgent() {
  agent = spawn(process.execPath, ["apps/agent/src/index.js"], {
    cwd: process.cwd(),
    env: agentEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  agent.stdout.on("data", (chunk) => { agentLogs += chunk; });
  agent.stderr.on("data", (chunk) => { agentLogs += chunk; });
  await waitForAgent();
}

async function stopSessionHost() {
  if (!sessionHost || sessionHost.exitCode !== null) return;
  const exited = once(sessionHost, "exit");
  sessionHost.kill("SIGTERM");
  const timedOut = delay(5000).then(() => "timeout");
  if (await Promise.race([exited, timedOut]) === "timeout") {
    sessionHost.kill("SIGKILL");
    await once(sessionHost, "exit");
  }
}

async function stopAgent() {
  if (!agent || agent.exitCode !== null) return;
  const exited = once(agent, "exit");
  agent.kill("SIGTERM");
  const timedOut = delay(5000).then(() => "timeout");
  if (await Promise.race([exited, timedOut]) === "timeout") {
    agent.kill("SIGKILL");
    await once(agent, "exit");
  }
}

async function waitForOutput(expected) {
  const deadline = Date.now() + 10000;
  let output = "";
  while (Date.now() < deadline) {
    const result = await request(`/v1/sessions/${sessionId}/output?cursor=0&maxBytes=262144`);
    output = result.output;
    if (output.includes(expected)) return output;
    await delay(100);
  }
  throw new Error(`Timed out waiting for synthetic output: ${expected}\n${output}`);
}

await fs.mkdir(workspace, { recursive: true });

try {
  const { stdout: tmuxVersion } = await execFileAsync("tmux", ["-V"]);
  await startSessionHost();
  await startAgent();

  const opened = await request("/v1/sessions", {
    method: "POST",
    body: { cwd: ".", label: "CI lifecycle smoke" },
  });
  sessionId = opened.id;

  const command = await request(`/v1/sessions/${sessionId}/commands`, {
    method: "POST",
    body: {
      command: "printf '\\160\\150\\141\\163\\145\\055\\157\\156\\145\\012'; sleep 2; printf '\\160\\150\\141\\163\\145\\055\\164\\167\\157\\012'",
      waitMs: 50,
    },
  });
  assert.equal(command.state, "running", "short MCP wait must not claim command completion");

  await stopAgent();
  await execFileAsync("tmux", ["-S", tmuxSocket, "has-session", "-t", `dpb_${sessionId}`]);

  await startAgent();
  const listed = await request("/v1/sessions");
  const restored = listed.sessions.find((session) => session.id === sessionId);
  assert.equal(restored?.alive, true, "session must remain alive across Agent restart");

  const continued = await waitForOutput("phase-two");
  assert.match(continued, /phase-one/);

  await request(`/v1/sessions/${sessionId}/input`, {
    method: "POST",
    body: {
      input: "printf '\\151\\156\\164\\145\\162\\141\\143\\164\\151\\166\\145\\055\\157\\153\\012'",
      enter: true,
    },
  });
  await waitForOutput("interactive-ok");

  await request(`/v1/sessions/${sessionId}`, { method: "DELETE" });
  sessionId = undefined;

  console.log(JSON.stringify({
    result: "pass",
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    tmux: tmuxVersion.trim(),
    scenarios: ["TERM-01", "TERM-03-partial", "TERM-10", "TERM-12"],
    limitations: ["systemd/cgroup restart is not covered by this CI smoke"],
  }));
} finally {
  await stopAgent();
  await stopSessionHost();
  if (sessionId) {
    await execFileAsync("tmux", ["-S", tmuxSocket, "kill-session", "-t", `dpb_${sessionId}`]).catch(() => {});
  }
  await execFileAsync("tmux", ["-S", tmuxSocket, "kill-server"]).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
}

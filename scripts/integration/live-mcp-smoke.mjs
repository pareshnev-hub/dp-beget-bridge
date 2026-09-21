import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const execFileAsync = promisify(execFile);

const endpoint = new URL(process.env.DP_MCP_SMOKE_URL || "http://127.0.0.1:8788/mcp");
const accessToken = process.env.DP_MCP_ACCESS_TOKEN || "";
const reconnectDelayMs = Number.parseInt(process.env.DP_MCP_SMOKE_RECONNECT_DELAY_MS || "2500", 10);

if (accessToken.length < 32) {
  throw new Error("DP_MCP_ACCESS_TOKEN must be loaded before running the live MCP smoke test");
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
    command: "printf '\\142\\145\\147\\145\\164\\055\\160\\150\\141\\163\\145\\055\\157\\156\\145\\012'; sleep 2; printf '\\142\\145\\147\\145\\164\\055\\160\\150\\141\\163\\145\\055\\164\\167\\157\\012'",
    wait_ms: 50,
  });
  assert.equal(command.state, "running", "short wait must not terminate or falsely complete the command");

  await disconnect();
  await delay(reconnectDelayMs);
  client = await connect();

  const listed = await callTool("list_terminal_sessions");
  assert.equal(
    listed.sessions.find((session) => session.id === sessionId)?.alive,
    true,
    "the terminal must remain alive after MCP client disconnect",
  );

  const continued = await waitForOutput("beget-phase-two");
  assert.match(continued, /beget-phase-one/);

  await callTool("send_terminal_input", {
    session_id: sessionId,
    input: "printf '\\142\\145\\147\\145\\164\\055\\151\\156\\164\\145\\162\\141\\143\\164\\151\\166\\145\\055\\157\\153\\012'",
    enter: true,
  });
  await waitForOutput("beget-interactive-ok");

  const guard = await callTool("open_terminal", { cwd: ".", label: "Beget close isolation guard" });
  cleanupSessionIds.add(guard.id);

  await callTool("close_terminal", { session_id: sessionId, keep_output: false });
  cleanupSessionIds.delete(sessionId);
  const afterClose = await callTool("list_terminal_sessions");
  assert.equal(
    afterClose.sessions.find((session) => session.id === guard.id)?.alive,
    true,
    "closing the selected terminal must not close another live session",
  );
  assert.equal(
    afterClose.sessions.some((session) => session.id === sessionId),
    false,
    "the selected terminal must be removed after explicit close",
  );
  sessionId = undefined;
  await callTool("close_terminal", { session_id: guard.id, keep_output: false });
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
    },
    scenarios: ["TERM-01", "TERM-10", "TERM-12"],
    supplemental: { clientDisconnectReconnect: "pass", serviceRestartCoveredHere: false },
  }));
} finally {
  if (cleanupSessionIds.size > 0) {
    if (!client) client = await connect().catch(() => undefined);
    if (client) {
      for (const id of cleanupSessionIds) {
        await callTool("close_terminal", { session_id: id, keep_output: false }).catch(() => {});
      }
    }
  }
  await disconnect();
}

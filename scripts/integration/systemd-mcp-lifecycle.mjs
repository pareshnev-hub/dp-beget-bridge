import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const suffix = `${process.pid}-${Date.now()}`;
const prefix = `dpb-systemd-${suffix}`;
const runtimeRoot = path.join("/var/lib", prefix);
const workspace = path.join(runtimeRoot, "workspace");
const dataDir = path.join(runtimeRoot, "data");
const tmuxSocket = path.join(runtimeRoot, "tmux", "tmux.sock");
const envFile = path.join(runtimeRoot, "bridge.env");
const agentUnit = `${prefix}-agent.service`;
const mcpUnit = `${prefix}-mcp.service`;
const agentUnitPath = path.join("/etc/systemd/system", agentUnit);
const mcpUnitPath = path.join("/etc/systemd/system", mcpUnit);
const agentToken = "systemd-agent-token-that-is-not-a-production-secret";
const mcpToken = "systemd-mcp-token-that-is-not-a-production-secret";
const runtimeUser = process.env.SUDO_USER || process.env.USER || "";

let client;
let sessionId;
let agentPort;
let mcpPort;
let runtimeGroup;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function output(command, args = []) {
  return (await execFileAsync(command, args, { encoding: "utf8" })).stdout.trim();
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth(url, unit) {
  const deadline = Date.now() + 15000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  const journal = await output("journalctl", ["-u", unit, "--no-pager", "-n", "100"]).catch(() => "journal unavailable");
  throw new Error(`Health timeout for ${unit}: ${lastError?.message || "unknown error"}\n${journal}`);
}

async function connectMcp() {
  const nextClient = new Client({ name: "dpb-systemd-integration", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcpPort}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${mcpToken}` } },
  });
  await nextClient.connect(transport);
  return nextClient;
}

async function disconnectMcp() {
  if (!client) return;
  await client.close().catch(() => {});
  client = undefined;
}

async function callTool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
}

async function waitForTerminalOutput(expected) {
  const deadline = Date.now() + 30000;
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
  throw new Error(`Timed out waiting for synthetic terminal output: ${expected}\n${last}`);
}

function unitBody({ description, execStart, after, requires = "", killMode = "control-group" }) {
  return `[Unit]\nDescription=${description}\nAfter=${after}\n${requires ? `Requires=${requires}\n` : ""}\n[Service]\nType=simple\nUser=${runtimeUser}\nGroup=${runtimeGroup}\nWorkingDirectory=${repoRoot}\nEnvironmentFile=${envFile}\nExecStart=${process.execPath} ${execStart}\nRestart=on-failure\nRestartSec=1\nKillMode=${killMode}\nTimeoutStopSec=15\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nReadWritePaths=${runtimeRoot}\n`;
}

if (process.getuid?.() !== 0) throw new Error("This integration test must run as root through sudo");
if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(runtimeUser) || runtimeUser === "root") {
  throw new Error(`A non-root SUDO_USER is required, received: ${runtimeUser || "<empty>"}`);
}
if (/\s/.test(repoRoot) || /\s/.test(process.execPath)) {
  throw new Error("The disposable systemd test requires repository and Node paths without whitespace");
}

try {
  const runtimeUid = Number(await output("id", ["-u", runtimeUser]));
  const runtimeGid = Number(await output("id", ["-g", runtimeUser]));
  runtimeGroup = await output("id", ["-gn", runtimeUser]);
  agentPort = await freePort();
  do mcpPort = await freePort(); while (mcpPort === agentPort);

  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  await fs.chown(runtimeRoot, runtimeUid, runtimeGid);
  await fs.chown(workspace, runtimeUid, runtimeGid);
  await fs.writeFile(envFile, [
    "DP_AGENT_HOST=127.0.0.1",
    `DP_AGENT_PORT=${agentPort}`,
    `DP_AGENT_URL=http://127.0.0.1:${agentPort}`,
    `DP_AGENT_TOKEN=${agentToken}`,
    "DP_MCP_HOST=127.0.0.1",
    `DP_MCP_PORT=${mcpPort}`,
    "DP_MCP_PATH=/mcp",
    `DP_MCP_ACCESS_TOKEN=${mcpToken}`,
    `DP_PUBLIC_URL=http://127.0.0.1:${mcpPort}`,
    `DP_DATA_DIR=${dataDir}`,
    `DP_ALLOWED_ROOTS=${workspace}`,
    `DP_TMUX_SOCKET=${tmuxSocket}`,
    "DP_COMMAND_WAIT_MS=50",
    "DP_TERMINAL_HISTORY_LINES=10000",
    `DP_SESSION_OUTPUT_WARN_BYTES=${4 * 1024 * 1024}`,
    `DP_FILE_UPLOAD_MAX_BYTES=${4 * 1024 * 1024}`,
    "DP_TELEMETRY_ENABLED=false",
    "DP_LOG_LEVEL=info",
    "",
  ].join("\n"), { mode: 0o640 });
  await fs.chown(envFile, 0, runtimeGid);

  await fs.writeFile(agentUnitPath, unitBody({
    description: "Disposable DP Beget Bridge Agent integration test",
    execStart: path.join(repoRoot, "apps/agent/src/index.js"),
    after: "network.target",
    killMode: "process",
  }));
  await fs.writeFile(mcpUnitPath, unitBody({
    description: "Disposable DP Beget Bridge MCP integration test",
    execStart: path.join(repoRoot, "apps/mcp/src/index.js"),
    after: `network.target ${agentUnit}`,
    requires: agentUnit,
  }));

  await execFileAsync("systemctl", ["daemon-reload"]);
  await execFileAsync("systemctl", ["start", mcpUnit]);
  await waitForHealth(`http://127.0.0.1:${agentPort}/health`, agentUnit);
  await waitForHealth(`http://127.0.0.1:${mcpPort}/health`, mcpUnit);
  client = await connectMcp();

  const opened = await callTool("open_terminal", { cwd: ".", label: "systemd lifecycle smoke" });
  sessionId = opened.id;
  const command = await callTool("run_terminal_command", {
    session_id: sessionId,
    command: "printf '\\160\\150\\141\\163\\145\\055\\157\\156\\145\\012'; sleep 12; printf '\\160\\150\\141\\163\\145\\055\\164\\167\\157\\012'",
    wait_ms: 50,
  });
  assert.equal(command.state, "running", "short MCP wait must not claim command completion");
  await waitForTerminalOutput("phase-one");

  await disconnectMcp();
  await execFileAsync("systemctl", ["restart", mcpUnit]);
  await waitForHealth(`http://127.0.0.1:${mcpPort}/health`, mcpUnit);
  client = await connectMcp();
  let listed = await callTool("list_terminal_sessions");
  assert.equal(listed.sessions.find((session) => session.id === sessionId)?.alive, true, "session must survive MCP restart");

  await disconnectMcp();
  await execFileAsync("systemctl", ["restart", agentUnit]);
  await waitForHealth(`http://127.0.0.1:${agentPort}/health`, agentUnit);
  await waitForHealth(`http://127.0.0.1:${mcpPort}/health`, mcpUnit);
  await execFileAsync("tmux", ["-S", tmuxSocket, "has-session", "-t", `dpb_${sessionId}`]);
  client = await connectMcp();
  listed = await callTool("list_terminal_sessions");
  assert.equal(listed.sessions.find((session) => session.id === sessionId)?.alive, true, "session must survive Agent systemd restart");

  const continued = await waitForTerminalOutput("phase-two");
  assert.match(continued, /phase-one/);
  await callTool("send_terminal_input", {
    session_id: sessionId,
    input: "printf '\\151\\156\\164\\145\\162\\141\\143\\164\\151\\166\\145\\055\\157\\153\\012'",
    enter: true,
  });
  await waitForTerminalOutput("interactive-ok");
  await callTool("close_terminal", { session_id: sessionId, keep_output: false });
  sessionId = undefined;

  const osRelease = await fs.readFile("/etc/os-release", "utf8");
  const prettyName = osRelease.match(/^PRETTY_NAME=(.*)$/m)?.[1]?.replace(/^"|"$/g, "") || `${os.platform()} ${os.release()}`;
  console.log(JSON.stringify({
    result: "pass",
    commit: process.env.GITHUB_SHA || await output("git", ["rev-parse", "HEAD"]),
    node: process.version,
    os: `${prettyName} ${os.arch()}`,
    systemd: (await output("systemctl", ["--version"])).split("\n")[0],
    tmux: await output("tmux", ["-V"]),
    profile: { privateTmp: true, protectSystem: "strict", explicitTmuxSocket: true },
    scenarios: ["TERM-01", "TERM-02", "TERM-03", "TERM-10", "TERM-12"],
  }));
} finally {
  await disconnectMcp();
  if (sessionId) {
    await execFileAsync("tmux", ["-S", tmuxSocket, "kill-session", "-t", `dpb_${sessionId}`]).catch(() => {});
  }
  await execFileAsync("tmux", ["-S", tmuxSocket, "kill-server"]).catch(() => {});
  await execFileAsync("systemctl", ["stop", mcpUnit, agentUnit]).catch(() => {});
  await fs.rm(agentUnitPath, { force: true });
  await fs.rm(mcpUnitPath, { force: true });
  await execFileAsync("systemctl", ["daemon-reload"]).catch(() => {});
  await execFileAsync("systemctl", ["reset-failed", agentUnit, mcpUnit]).catch(() => {});
  await fs.rm(runtimeRoot, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SessionHostClient } from "../../apps/agent/src/session-host-client.js";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const suffix = `${process.pid}-${Date.now()}`;
const prefix = `dpb-systemd-${suffix}`;
const runtimeRoot = path.join("/var/lib", prefix);
const workspace = path.join(runtimeRoot, "workspace");
const sessionDataDir = path.join(runtimeRoot, "session-data");
const agentDataDir = path.join(runtimeRoot, "agent-data");
const socketDir = path.join(runtimeRoot, "run");
const sessionHostSocket = path.join(socketDir, "session-host.sock");
const tmuxSocket = path.join(sessionDataDir, "tmux", "tmux.sock");
const sessionHostEnvFile = path.join(runtimeRoot, "session-host.env");
const agentEnvFile = path.join(runtimeRoot, "agent.env");
const mcpEnvFile = path.join(runtimeRoot, "mcp.env");
const legacyConfigDir = path.join(runtimeRoot, "legacy-config");
const legacyTmuxSocket = path.join(runtimeRoot, "legacy-tmux", "tmux.sock");
const installFixtureSource = path.join(runtimeRoot, "installer-source");
const installFixtureTarget = path.join(runtimeRoot, "installer-target");
const installedCodeRoot = path.join(runtimeRoot, "installed-code");
const agentUnit = `${prefix}-agent.service`;
const mcpUnit = `${prefix}-mcp.service`;
const sessionHostUnit = `${prefix}-session-host.service`;
const agentUnitPath = path.join("/etc/systemd/system", agentUnit);
const mcpUnitPath = path.join("/etc/systemd/system", mcpUnit);
const sessionHostUnitPath = path.join("/etc/systemd/system", sessionHostUnit);
const agentToken = "systemd-agent-token-that-is-not-a-production-secret";
const mcpToken = "systemd-mcp-token-that-is-not-a-production-secret";
const workUser = process.env.SUDO_USER || process.env.USER || "";
const identitySuffix = String(process.pid);
const agentUser = `dpba${identitySuffix}`;
const mcpUser = `dpbm${identitySuffix}`;
const ipcGroup = `dpbg${identitySuffix}`;

let client;
let sessionId;
let guardSessionId;
let agentPort;
let mcpPort;
let workGroup;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function output(command, args = []) {
  return (await execFileAsync(command, args, { encoding: "utf8" })).stdout.trim();
}

async function assertInstallerRejectsRoot(args, expected) {
  const { SUDO_USER: _sudoUser, ...rootEnvironment } = process.env;
  rootEnvironment.USER = "root";
  try {
    await execFileAsync("bash", ["deploy/install.sh", "--domain", "bridge.invalid", ...args], {
      cwd: repoRoot,
      env: rootEnvironment,
      encoding: "utf8",
    });
    assert.fail("installer unexpectedly accepted a root runtime identity");
  } catch (error) {
    assert.notEqual(error.code, 0);
    assert.match(`${error.stdout || ""}${error.stderr || ""}`, expected);
  }
}

async function assertCannotRead(user, file) {
  let readable = true;
  try {
    await execFileAsync("runuser", ["-u", user, "--", "test", "-r", file]);
  } catch {
    readable = false;
  }
  assert.equal(readable, false, `${user} unexpectedly read ${file}`);
}

async function assertInstallerBlocksLiveLegacyMigration() {
  const legacySocketDir = path.dirname(legacyTmuxSocket);
  const workUid = Number(await output("id", ["-u", workUser]));
  const workGid = Number(await output("id", ["-g", workUser]));
  await fs.mkdir(legacyConfigDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(legacySocketDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
  await fs.chmod(runtimeRoot, 0o755);
  await fs.chown(legacySocketDir, workUid, workGid);
  await fs.chown(workspace, workUid, workGid);
  await fs.writeFile(path.join(legacyConfigDir, "bridge.env"), [
    `DP_TMUX_SOCKET=${legacyTmuxSocket}`,
    "DP_AGENT_TOKEN=legacy-agent-canary",
    "DP_MCP_ACCESS_TOKEN=legacy-mcp-canary",
    "",
  ].join("\n"), { mode: 0o600 });
  await execFileAsync("runuser", [
    "-u", workUser, "--", "tmux", "-S", legacyTmuxSocket,
    "new-session", "-d", "-s", "dpb_legacy_migration_guard", "sleep 60",
  ]);
  try {
    await execFileAsync("bash", [
      "deploy/install.sh",
      "--domain", "bridge.invalid",
      "--user", workUser,
      "--allowed-root", workspace,
    ], {
      cwd: repoRoot,
      env: { ...process.env, DP_INSTALL_CONFIG_DIR: legacyConfigDir },
      encoding: "utf8",
    });
    assert.fail("installer unexpectedly migrated a live legacy tmux server");
  } catch (error) {
    assert.notEqual(error.code, 0);
    assert.match(`${error.stdout || ""}${error.stderr || ""}`, /Legacy migration stopped/);
  } finally {
    await execFileAsync("runuser", ["-u", workUser, "--", "tmux", "-S", legacyTmuxSocket, "kill-server"])
      .catch(() => {});
    await fs.rm(legacyConfigDir, { recursive: true, force: true });
  }
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

async function waitForSessionHost() {
  const deadline = Date.now() + 15000;
  const probe = new SessionHostClient({ socketPath: sessionHostSocket });
  let lastError;
  while (Date.now() < deadline) {
    try {
      const health = await probe.request("/health");
      if (health.status === "ok") return;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Session Host health timeout: ${lastError?.message || "unknown error"}`);
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

function unitBody({
  description,
  execStart,
  after,
  user,
  group,
  environmentFile,
  requires = "",
  wants = "",
  supplementaryGroups = "",
  killMode = "control-group",
  readWritePaths = runtimeRoot,
  workingDirectory = repoRoot,
}) {
  return `[Unit]\nDescription=${description}\nAfter=${after}\n${requires ? `Requires=${requires}\n` : ""}${wants ? `Wants=${wants}\n` : ""}\n[Service]\nType=simple\nUser=${user}\nGroup=${group}\n${supplementaryGroups ? `SupplementaryGroups=${supplementaryGroups}\n` : ""}WorkingDirectory=${workingDirectory}\nEnvironmentFile=${environmentFile}\nExecStart=${process.execPath} ${execStart}\nRestart=on-failure\nRestartSec=1\nKillMode=${killMode}\nTimeoutStopSec=15\nTasksMax=128\nLimitNOFILE=4096\nMemoryMax=512M\nMemorySwapMax=512M\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nReadWritePaths=${readWritePaths}\n`;
}

if (process.getuid?.() !== 0) throw new Error("This integration test must run as root through sudo");
if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(workUser) || workUser === "root") {
  throw new Error(`A non-root SUDO_USER is required, received: ${workUser || "<empty>"}`);
}
if (/\s/.test(repoRoot) || /\s/.test(process.execPath)) {
  throw new Error("The disposable systemd test requires repository and Node paths without whitespace");
}

try {
  await assertInstallerRejectsRoot([], /non-root work user is required/);
  await assertInstallerRejectsRoot(["--user", "root"], /Refusing to run Agent, MCP, or terminal sessions as root/);
  await assertInstallerBlocksLiveLegacyMigration();

  workGroup = await output("id", ["-gn", workUser]);
  const workUid = Number(await output("id", ["-u", workUser]));
  const workGid = Number(await output("id", ["-g", workUser]));
  await execFileAsync("groupadd", ["--system", ipcGroup]);
  await execFileAsync("groupadd", ["--system", agentUser]);
  await execFileAsync("groupadd", ["--system", mcpUser]);
  await execFileAsync("useradd", ["--system", "--gid", agentUser, "--no-create-home", "--shell", "/usr/sbin/nologin", agentUser]);
  await execFileAsync("useradd", ["--system", "--gid", mcpUser, "--no-create-home", "--shell", "/usr/sbin/nologin", mcpUser]);
  await execFileAsync("usermod", ["-a", "-G", ipcGroup, agentUser]);
  await execFileAsync("usermod", ["-a", "-G", ipcGroup, workUser]);
  const agentUid = Number(await output("id", ["-u", agentUser]));
  const agentGid = Number(await output("id", ["-g", agentUser]));
  const mcpGid = Number(await output("id", ["-g", mcpUser]));
  const ipcGid = Number((await output("getent", ["group", ipcGroup])).split(":")[2]);
  agentPort = await freePort();
  do mcpPort = await freePort(); while (mcpPort === agentPort);

  await fs.mkdir(workspace, { recursive: true, mode: 0o2770 });
  await fs.mkdir(sessionDataDir, { mode: 0o700 });
  await fs.mkdir(agentDataDir, { mode: 0o700 });
  await fs.mkdir(socketDir, { mode: 0o750 });
  await fs.chown(workspace, workUid, ipcGid);
  await fs.chmod(workspace, 0o2770);
  await fs.chown(sessionDataDir, workUid, workGid);
  await fs.chown(agentDataDir, agentUid, agentGid);
  await fs.chown(socketDir, workUid, ipcGid);

  await fs.mkdir(installFixtureSource, { mode: 0o700 });
  await fs.writeFile(path.join(installFixtureSource, "probe.txt"), "installer-mode-probe\n");
  await execFileAsync("bash", [
    "-c",
    "source \"$1\"; install_code_tree \"$2\" \"$3\"",
    "installer-mode-test",
    path.join(repoRoot, "deploy/lib/install-code.sh"),
    installFixtureSource,
    installFixtureTarget,
  ]);
  const installedRoot = await fs.stat(installFixtureTarget);
  assert.equal(installedRoot.mode & 0o777, 0o755, "installed code root must remain traversable by service users");
  assert.equal(installedRoot.uid, 0, "installed code root must remain root-owned");
  assert.equal(installedRoot.gid, 0, "installed code root must remain root-owned");
  await execFileAsync("runuser", [
    "-u",
    workUser,
    "--",
    "test",
    "-r",
    path.join(installFixtureTarget, "probe.txt"),
  ]);
  await execFileAsync("bash", [
    "-c",
    "source \"$1\"; install_code_tree \"$2\" \"$3\"",
    "installed-code-test",
    path.join(repoRoot, "deploy/lib/install-code.sh"),
    repoRoot,
    installedCodeRoot,
  ]);
  await fs.writeFile(sessionHostEnvFile, [
    `DP_SESSION_HOST_SOCKET=${sessionHostSocket}`,
    `DP_SESSION_DATA_DIR=${sessionDataDir}`,
    `DP_ALLOWED_ROOTS=${workspace}`,
    `DP_TMUX_SOCKET=${tmuxSocket}`,
    "DP_COMMAND_WAIT_MS=50",
    "DP_TERMINAL_HISTORY_LINES=10000",
    "DP_TERMINAL_MAX_ACTIVE=8",
    `DP_SESSION_OUTPUT_WARN_BYTES=${4 * 1024 * 1024}`,
    `DP_SESSION_OUTPUT_MAX_BYTES=${8 * 1024 * 1024}`,
    "DP_STORAGE_MIN_FREE_BYTES=1048576",
    "DP_LOG_LEVEL=info",
    "",
  ].join("\n"), { mode: 0o640 });
  await fs.chown(sessionHostEnvFile, 0, workGid);

  await fs.writeFile(agentEnvFile, [
    "DP_AGENT_HOST=127.0.0.1",
    `DP_AGENT_PORT=${agentPort}`,
    `DP_AGENT_TOKEN=${agentToken}`,
    `DP_SESSION_HOST_SOCKET=${sessionHostSocket}`,
    `DP_DATA_DIR=${agentDataDir}`,
    `DP_ALLOWED_ROOTS=${workspace}`,
    `DP_FILE_UPLOAD_MAX_BYTES=${4 * 1024 * 1024}`,
    "DP_FILE_TRANSFER_MAX_CONCURRENT=2",
    "DP_STORAGE_MIN_FREE_BYTES=1048576",
    "DP_TELEMETRY_ENABLED=false",
    "DP_LOG_LEVEL=info",
    "",
  ].join("\n"), { mode: 0o640 });
  await fs.chown(agentEnvFile, 0, agentGid);

  await fs.writeFile(mcpEnvFile, [
    `DP_AGENT_URL=http://127.0.0.1:${agentPort}`,
    `DP_AGENT_TOKEN=${agentToken}`,
    "DP_MCP_HOST=127.0.0.1",
    `DP_MCP_PORT=${mcpPort}`,
    "DP_MCP_PATH=/mcp",
    `DP_MCP_ACCESS_TOKEN=${mcpToken}`,
    `DP_PUBLIC_URL=http://127.0.0.1:${mcpPort}`,
    "DP_LOG_LEVEL=info",
    "",
  ].join("\n"), { mode: 0o640 });
  await fs.chown(mcpEnvFile, 0, mcpGid);

  assert.doesNotMatch(await fs.readFile(sessionHostEnvFile, "utf8"), /TOKEN|SECRET|PASSWORD/i);
  await assertCannotRead(workUser, agentEnvFile);
  await assertCannotRead(workUser, mcpEnvFile);
  await assertCannotRead(agentUser, mcpEnvFile);
  await assertCannotRead(mcpUser, agentEnvFile);

  await fs.writeFile(sessionHostUnitPath, unitBody({
    description: "Disposable DP Beget Bridge Session Host integration test",
    execStart: path.join(installedCodeRoot, "apps/session-host/src/index.js"),
    after: "network.target",
    user: workUser,
    group: ipcGroup,
    supplementaryGroups: workGroup,
    environmentFile: sessionHostEnvFile,
    killMode: "process",
    readWritePaths: `${sessionDataDir} ${socketDir} ${workspace}`,
    workingDirectory: installedCodeRoot,
  }));

  await fs.writeFile(agentUnitPath, unitBody({
    description: "Disposable DP Beget Bridge Agent integration test",
    execStart: path.join(installedCodeRoot, "apps/agent/src/index.js"),
    after: `network.target ${sessionHostUnit}`,
    wants: sessionHostUnit,
    user: agentUser,
    group: agentUser,
    supplementaryGroups: ipcGroup,
    environmentFile: agentEnvFile,
    readWritePaths: `${agentDataDir} ${workspace}`,
    workingDirectory: installedCodeRoot,
  }));
  await fs.writeFile(mcpUnitPath, unitBody({
    description: "Disposable DP Beget Bridge MCP integration test",
    execStart: path.join(installedCodeRoot, "apps/mcp/src/index.js"),
    after: `network.target ${agentUnit}`,
    requires: agentUnit,
    user: mcpUser,
    group: mcpUser,
    environmentFile: mcpEnvFile,
    workingDirectory: installedCodeRoot,
  }));

  await execFileAsync("systemd-analyze", ["verify", sessionHostUnitPath, agentUnitPath, mcpUnitPath]);
  await execFileAsync("systemctl", ["daemon-reload"]);
  await execFileAsync("systemctl", ["start", mcpUnit]);
  for (const unit of [sessionHostUnit, agentUnit, mcpUnit]) {
    const controls = await output("systemctl", [
      "show",
      unit,
      "--property=TasksMax,LimitNOFILE,MemoryMax,MemorySwapMax,NoNewPrivileges",
    ]);
    assert.match(controls, /^TasksMax=128$/m);
    assert.match(controls, /^LimitNOFILE=4096$/m);
    assert.match(controls, /^MemoryMax=536870912$/m);
    assert.match(controls, /^MemorySwapMax=536870912$/m);
    assert.match(controls, /^NoNewPrivileges=yes$/m);
  }
  const doctor = await execFileAsync(process.execPath, [path.join(installedCodeRoot, "scripts/doctor.mjs")], {
    cwd: installedCodeRoot,
    env: {
      ...process.env,
      DP_AGENT_URL: `http://127.0.0.1:${agentPort}`,
      DP_MCP_URL: `http://127.0.0.1:${mcpPort}`,
      DP_SESSION_HOST_SOCKET: sessionHostSocket,
      DP_AGENT_SYSTEMD_UNIT: agentUnit,
      DP_MCP_SYSTEMD_UNIT: mcpUnit,
      DP_SESSION_HOST_SYSTEMD_UNIT: sessionHostUnit,
    },
    encoding: "utf8",
  });
  assert.match(doctor.stdout, /OK  Session Host health: ok/);
  assert.match(doctor.stdout, /OK  Runtime identities:/);
  await waitForSessionHost();
  await waitForHealth(`http://127.0.0.1:${agentPort}/health`, agentUnit);
  await waitForHealth(`http://127.0.0.1:${mcpPort}/health`, mcpUnit);
  client = await connectMcp();

  const opened = await callTool("open_terminal", { cwd: ".", label: "systemd lifecycle smoke" });
  sessionId = opened.id;
  const command = await callTool("run_terminal_command", {
    session_id: sessionId,
    idempotency_key: `systemd-phase-${suffix}`,
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

  await disconnectMcp();
  await execFileAsync("systemctl", ["restart", sessionHostUnit]);
  await waitForSessionHost();
  await execFileAsync("tmux", ["-S", tmuxSocket, "has-session", "-t", `dpb_${sessionId}`]);
  client = await connectMcp();
  listed = await callTool("list_terminal_sessions");
  assert.equal(
    listed.sessions.find((session) => session.id === sessionId)?.alive,
    true,
    "session must survive Session Host restart",
  );

  const continued = await waitForTerminalOutput("phase-two");
  assert.match(continued, /phase-one/);
  const uncertain = await callTool("get_terminal_operation", {
    session_id: sessionId,
    operation_id: command.operationId,
  });
  assert.equal(uncertain.status, "UNKNOWN", "Session Host restart must not replay an uncertain operation");
  await callTool("interrupt_terminal", { session_id: sessionId });
  await callTool("send_terminal_input", {
    session_id: sessionId,
    input: "printf '\\151\\156\\164\\145\\162\\141\\143\\164\\151\\166\\145\\055\\157\\153\\012'",
    enter: true,
  });
  await waitForTerminalOutput("interactive-ok");

  const sharedFile = `dp009-shared-${suffix}.txt`;
  const sharedWrite = await callTool("run_terminal_command", {
    session_id: sessionId,
    idempotency_key: `systemd-shared-${suffix}`,
    command: "printf '\\163\\150\\141\\162\\145\\144\\055\\167\\157\\162\\153\\163\\160\\141\\143\\145\\012' > " + sharedFile,
    wait_ms: 5000,
  });
  assert.equal(sharedWrite.state, "completed", "work identity must be able to create a shared workspace file");
  const sharedList = await callTool("list_files", { path: "." });
  assert.equal(
    sharedList.entries.some((entry) => entry.name === sharedFile),
    true,
    "Agent identity must be able to inspect work-created files through the shared workspace group",
  );
  await callTool("delete_path", { path: sharedFile, recursive: false });

  const guard = await callTool("open_terminal", { cwd: ".", label: "interrupt isolation guard" });
  guardSessionId = guard.id;
  const interruptTarget = await callTool("run_terminal_command", {
    session_id: sessionId,
    idempotency_key: `systemd-interrupt-${suffix}`,
    command: "sleep 30",
    wait_ms: 50,
  });
  assert.equal(interruptTarget.state, "running");
  await callTool("interrupt_terminal", { session_id: sessionId });
  await delay(250);
  listed = await callTool("list_terminal_sessions");
  assert.equal(
    listed.sessions.find((session) => session.id === guardSessionId)?.alive,
    true,
    "interrupting one foreground process must not affect another session",
  );
  const afterInterrupt = await callTool("run_terminal_command", {
    session_id: sessionId,
    idempotency_key: `systemd-after-interrupt-${suffix}`,
    command: "printf '\\160\\157\\163\\164\\055\\151\\156\\164\\145\\162\\162\\165\\160\\164\\055\\157\\153\\012'",
    wait_ms: 5000,
  });
  assert.equal(afterInterrupt.state, "completed", "the interrupted terminal must remain usable");

  await callTool("close_terminal", { session_id: sessionId });
  listed = await callTool("list_terminal_sessions");
  assert.equal(listed.sessions.find((session) => session.id === sessionId)?.state, "CLOSED");
  assert.equal(listed.sessions.find((session) => session.id === sessionId)?.alive, false);
  assert.equal(listed.sessions.find((session) => session.id === guardSessionId)?.alive, true);
  await callTool("purge_terminal", { session_id: sessionId });
  sessionId = undefined;
  await callTool("close_terminal", { session_id: guardSessionId });
  await callTool("purge_terminal", { session_id: guardSessionId });
  guardSessionId = undefined;

  const osRelease = await fs.readFile("/etc/os-release", "utf8");
  const prettyName = osRelease.match(/^PRETTY_NAME=(.*)$/m)?.[1]?.replace(/^"|"$/g, "") || `${os.platform()} ${os.release()}`;
  console.log(JSON.stringify({
    result: "pass",
    commit: process.env.GITHUB_SHA || await output("git", ["rev-parse", "HEAD"]),
    node: process.version,
    os: `${prettyName} ${os.arch()}`,
    systemd: (await output("systemctl", ["--version"])).split("\n")[0],
    tmux: await output("tmux", ["-V"]),
    profile: {
      privateTmp: true,
      protectSystem: "strict",
      explicitTmuxSocket: true,
      identities: { mcp: mcpUser, agent: agentUser, work: workUser },
      workCannotReadServiceCredentials: true,
    },
    scenarios: [
      "TERM-01",
      "TERM-02",
      "TERM-03",
      "TERM-07",
      "TERM-10",
      "TERM-11",
      "TERM-12",
      "OPS-01-install-root-mode",
      "OPS-03",
      "DP-009-identity-acl",
      "DP-009-session-host-restart",
      "DP-009-shared-workspace",
    ],
  }));
} finally {
  await disconnectMcp();
  if (sessionId) {
    await execFileAsync("tmux", ["-S", tmuxSocket, "kill-session", "-t", `dpb_${sessionId}`]).catch(() => {});
  }
  await execFileAsync("tmux", ["-S", tmuxSocket, "kill-server"]).catch(() => {});
  await execFileAsync("systemctl", ["stop", mcpUnit, agentUnit, sessionHostUnit]).catch(() => {});
  await fs.rm(agentUnitPath, { force: true });
  await fs.rm(mcpUnitPath, { force: true });
  await fs.rm(sessionHostUnitPath, { force: true });
  await execFileAsync("systemctl", ["daemon-reload"]).catch(() => {});
  await execFileAsync("systemctl", ["reset-failed", agentUnit, mcpUnit, sessionHostUnit]).catch(() => {});
  await fs.rm(runtimeRoot, { recursive: true, force: true });
  await execFileAsync("userdel", [agentUser]).catch(() => {});
  await execFileAsync("userdel", [mcpUser]).catch(() => {});
  await execFileAsync("groupdel", [agentUser]).catch(() => {});
  await execFileAsync("groupdel", [mcpUser]).catch(() => {});
  await execFileAsync("groupdel", [ipcGroup]).catch(() => {});
}

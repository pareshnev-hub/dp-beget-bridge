import http from "node:http";
import { execFileSync } from "node:child_process";

const checks = [];
const startupWaitMs = Number(process.env.DP_DOCTOR_WAIT_MS || "15000");
const json = process.argv.length === 3 && process.argv[2] === "--json";
if ((process.argv.length !== 2 && !json) || !Number.isSafeInteger(startupWaitMs) ||
    startupWaitMs < 1 || startupWaitMs > 300000) {
  console.error("Usage: node scripts/doctor.mjs [--json]");
  process.exit(64);
}
const probeTimeoutMs = Math.min(1500, startupWaitMs);
const units = [
  process.env.DP_MCP_SYSTEMD_UNIT || "dp-beget-mcp.service",
  process.env.DP_AGENT_SYSTEMD_UNIT || "dp-beget-agent.service",
  process.env.DP_SESSION_HOST_SYSTEMD_UNIT || "dp-beget-session-host.service",
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function diagnosticFailure(error) {
  if (/^HTTP \d{3}$/.test(error?.message || "")) return error.message;
  const code = error?.code || error?.cause?.code;
  return code && /^[A-Z0-9_-]{1,40}$/i.test(String(code))
    ? `unavailable (${code})`
    : "check failed";
}

async function eventually(action) {
  const deadline = Date.now() + startupWaitMs;
  let lastError;
  do {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  } while (Date.now() < deadline);
  throw lastError || new Error("health check timed out");
}

async function check(name, action) {
  try {
    const detail = await action();
    checks.push({ name, ok: true, detail });
  } catch (error) {
    checks.push({ name, ok: false, detail: diagnosticFailure(error) });
  }
}

await check("Node.js", () => {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) throw new Error(`version ${process.versions.node}; need 22+`);
  return process.versions.node;
});
await check("tmux", () => {
  const version = execFileSync(process.env.DP_TMUX_BIN || "tmux", ["-V"],
    { encoding: "utf8", timeout: probeTimeoutMs, maxBuffer: 1024 }).trim();
  if (!/^tmux [0-9][a-zA-Z0-9. -]{0,32}$/.test(version)) throw new Error("Invalid tmux version");
  return version;
});
await check("Agent health", () => eventually(async () => {
  const response = await fetch(`${process.env.DP_AGENT_URL || "http://127.0.0.1:8787"}/health`,
    { signal: AbortSignal.timeout(probeTimeoutMs), redirect: "error" });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return "ok";
}));
await check("MCP health", () => eventually(async () => {
  const response = await fetch(`${process.env.DP_MCP_URL || "http://127.0.0.1:8788"}/health`,
    { signal: AbortSignal.timeout(probeTimeoutMs), redirect: "error" });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return "ok";
}));
await check("Session Host health", () => eventually(() => new Promise((resolve, reject) => {
  const request = http.get({
    socketPath: process.env.DP_SESSION_HOST_SOCKET || "/run/dp-beget-bridge/session-host.sock",
    path: "/health",
    signal: AbortSignal.timeout(probeTimeoutMs),
  }, (response) => {
    response.resume();
    response.on("end", () => response.statusCode === 200
      ? resolve("ok")
      : reject(new Error(`HTTP ${response.statusCode}`)));
  });
  request.on("error", reject);
})));
await check("Runtime identities", () => {
  const users = units.map((unit) => execFileSync(
    "systemctl",
    ["show", unit, "--property=User", "--value"],
    { encoding: "utf8", timeout: probeTimeoutMs, maxBuffer: 1024 },
  ).trim());
  if (new Set(users).size !== users.length || users.includes("root") ||
      users.some(user => !/^[a-z_][a-z0-9_-]{0,31}$/.test(user))) {
    throw new Error("Invalid runtime identities");
  }
  return users.join(", ");
});

if (json) console.log(JSON.stringify({ format: "dp-beget-doctor-v1", checks }));
else for (const item of checks) {
  console.log(`${item.ok ? "OK" : "FAIL"}  ${item.name}: ${item.detail}`);
}
if (checks.some((item) => !item.ok)) process.exit(1);

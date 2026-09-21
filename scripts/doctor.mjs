import http from "node:http";
import { execFileSync } from "node:child_process";

const checks = [];
const startupWaitMs = Number.parseInt(process.env.DP_DOCTOR_WAIT_MS || "15000", 10);
const units = [
  process.env.DP_MCP_SYSTEMD_UNIT || "dp-beget-mcp.service",
  process.env.DP_AGENT_SYSTEMD_UNIT || "dp-beget-agent.service",
  process.env.DP_SESSION_HOST_SYSTEMD_UNIT || "dp-beget-session-host.service",
];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    checks.push({ name, ok: false, detail: error.message });
  }
}

await check("Node.js", () => {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) throw new Error(`version ${process.versions.node}; need 22+`);
  return process.versions.node;
});
await check("tmux", () => execFileSync(process.env.DP_TMUX_BIN || "tmux", ["-V"], { encoding: "utf8" }).trim());
await check("Agent health", () => eventually(async () => {
  const response = await fetch(`${process.env.DP_AGENT_URL || "http://127.0.0.1:8787"}/health`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return "ok";
}));
await check("MCP health", () => eventually(async () => {
  const response = await fetch(`${process.env.DP_MCP_URL || "http://127.0.0.1:8788"}/health`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return "ok";
}));
await check("Session Host health", () => eventually(() => new Promise((resolve, reject) => {
  const request = http.get({
    socketPath: process.env.DP_SESSION_HOST_SOCKET || "/run/dp-beget-bridge/session-host.sock",
    path: "/health",
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
    { encoding: "utf8" },
  ).trim());
  if (new Set(users).size !== users.length || users.includes("root") || users.includes("")) {
    throw new Error(`expected three distinct non-root identities; received ${users.join(", ")}`);
  }
  return users.join(", ");
});

for (const item of checks) {
  console.log(`${item.ok ? "OK" : "FAIL"}  ${item.name}: ${item.detail}`);
}
if (checks.some((item) => !item.ok)) process.exit(1);

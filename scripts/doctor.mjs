import http from "node:http";
import { execFileSync } from "node:child_process";

const checks = [];

function check(name, action) {
  try {
    const detail = action();
    checks.push({ name, ok: true, detail });
  } catch (error) {
    checks.push({ name, ok: false, detail: error.message });
  }
}

check("Node.js", () => {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) throw new Error(`version ${process.versions.node}; need 22+`);
  return process.versions.node;
});
check("tmux", () => execFileSync(process.env.DP_TMUX_BIN || "tmux", ["-V"], { encoding: "utf8" }).trim());
check("Agent health", async () => {
  const response = await fetch(`${process.env.DP_AGENT_URL || "http://127.0.0.1:8787"}/health`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return "ok";
});
check("MCP health", async () => {
  const response = await fetch(`${process.env.DP_MCP_URL || "http://127.0.0.1:8788"}/health`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return "ok";
});
check("Session Host health", () => new Promise((resolve, reject) => {
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
}));
check("Runtime identities", () => {
  const units = ["dp-beget-mcp.service", "dp-beget-agent.service", "dp-beget-session-host.service"];
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
  if (item.detail instanceof Promise) {
    try { item.detail = await item.detail; }
    catch (error) { item.ok = false; item.detail = error.message; }
  }
  console.log(`${item.ok ? "OK" : "FAIL"}  ${item.name}: ${item.detail}`);
}
if (checks.some((item) => !item.ok)) process.exit(1);

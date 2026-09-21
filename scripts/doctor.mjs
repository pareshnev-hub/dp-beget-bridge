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

for (const item of checks) {
  if (item.detail instanceof Promise) {
    try { item.detail = await item.detail; }
    catch (error) { item.ok = false; item.detail = error.message; }
  }
  console.log(`${item.ok ? "OK" : "FAIL"}  ${item.name}: ${item.detail}`);
}
if (checks.some((item) => !item.ok)) process.exit(1);

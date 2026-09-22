import { spawnSync } from "node:child_process";

const checks = [];

function record(ok, label, detail = "") {
  checks.push({ ok, label, detail });
  console.log(`${ok ? "OK" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
}

const unit = spawnSync(
  "systemctl",
  ["show", "dp-beget-tunnel.service", "--property=ActiveState,SubState,User,Group,NRestarts", "--no-pager"],
  { encoding: "utf8" },
);
const properties = Object.fromEntries(
  unit.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
record(
  unit.status === 0 && properties.ActiveState === "active" && properties.SubState === "running",
  "Tunnel service",
  `${properties.ActiveState || "unknown"}/${properties.SubState || "unknown"}`,
);
record(properties.User === "dp-tunnel" && properties.Group === "dp-tunnel", "Tunnel identity", "dp-tunnel");

for (const path of ["healthz", "readyz"]) {
  try {
    const response = await fetch(`http://127.0.0.1:8790/${path}`, { signal: AbortSignal.timeout(3000) });
    record(response.ok, `Tunnel ${path}`, response.ok ? "ok" : `HTTP ${response.status}`);
  } catch {
    record(false, `Tunnel ${path}`, "unavailable");
  }
}

const listeners = spawnSync("ss", ["-ltnp"], { encoding: "utf8" });
const tunnelListeners = listeners.stdout
  .split("\n")
  .filter((line) => /:8790\s/.test(line));
record(
  tunnelListeners.length === 1 && /127\.0\.0\.1:8790\s/.test(tunnelListeners[0]),
  "Tunnel admin listener",
  "127.0.0.1:8790",
);

if (checks.some((check) => !check.ok)) process.exit(1);

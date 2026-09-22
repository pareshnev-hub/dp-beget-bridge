import os from "node:os";
import path from "node:path";

function integer(name, fallback) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadConfig() {
  const dataDir = path.resolve(process.env.DP_DATA_DIR || "./runtime/agent");
  return {
    agentId: process.env.DP_AGENT_ID || os.hostname(),
    host: process.env.DP_AGENT_HOST || "127.0.0.1",
    port: integer("DP_AGENT_PORT", 8787),
    token: process.env.DP_AGENT_TOKEN || "",
    dataDir,
    sessionHostSocket: path.resolve(process.env.DP_SESSION_HOST_SOCKET || "/run/dp-beget-bridge/session-host.sock"),
    allowedRoots: (process.env.DP_ALLOWED_ROOTS || process.cwd())
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    tmuxBin: process.env.DP_TMUX_BIN || "tmux",
    tmuxSocket: process.env.DP_TMUX_SOCKET ? path.resolve(process.env.DP_TMUX_SOCKET) : "",
    historyLines: integer("DP_TERMINAL_HISTORY_LINES", 100000),
    commandWaitMs: integer("DP_COMMAND_WAIT_MS", 10000),
    sessionOutputWarnBytes: integer("DP_SESSION_OUTPUT_WARN_BYTES", 50 * 1024 * 1024),
    storageMinFreeBytes: integer("DP_STORAGE_MIN_FREE_BYTES", 256 * 1024 * 1024),
    fileUploadMaxBytes: integer("DP_FILE_UPLOAD_MAX_BYTES", 512 * 1024 * 1024),
    telemetryEnabled: /^(1|true|yes)$/i.test(process.env.DP_TELEMETRY_ENABLED || "false"),
    telemetryUrl: process.env.DP_TELEMETRY_URL || "https://pareshnev.com/api/dp-beget-bridge/events",
  };
}

import path from "node:path";

function integer(name, fallback) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadSessionHostConfig() {
  const dataDir = path.resolve(process.env.DP_SESSION_DATA_DIR || "/var/lib/dp-beget-bridge/session-host");
  return {
    dataDir,
    socketPath: path.resolve(process.env.DP_SESSION_HOST_SOCKET || "/run/dp-beget-bridge/session-host.sock"),
    allowedRoots: (process.env.DP_ALLOWED_ROOTS || process.cwd())
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    tmuxBin: process.env.DP_TMUX_BIN || "tmux",
    tmuxSocket: process.env.DP_TMUX_SOCKET
      ? path.resolve(process.env.DP_TMUX_SOCKET)
      : path.join(dataDir, "tmux", "tmux.sock"),
    historyLines: integer("DP_TERMINAL_HISTORY_LINES", 100000),
    commandWaitMs: integer("DP_COMMAND_WAIT_MS", 10000),
    sessionOutputWarnBytes: integer("DP_SESSION_OUTPUT_WARN_BYTES", 50 * 1024 * 1024),
  };
}

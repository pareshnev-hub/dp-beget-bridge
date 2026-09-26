import path from "node:path";

function integer(name, fallback) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a nonnegative safe integer`);
  return value;
}

export function loadSessionHostConfig() {
  const dataDir = path.resolve(process.env.DP_SESSION_DATA_DIR || "/var/lib/dp-beget-bridge/session-host");
  const config = {
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
    terminalMaxActive: integer("DP_TERMINAL_MAX_ACTIVE", 8),
    commandWaitMs: integer("DP_COMMAND_WAIT_MS", 10000),
    sessionOutputWarnBytes: integer("DP_SESSION_OUTPUT_WARN_BYTES", 50 * 1024 * 1024),
    sessionOutputMaxBytes: integer("DP_SESSION_OUTPUT_MAX_BYTES", 64 * 1024 * 1024),
    transcriptTotalMaxBytes: integer("DP_TRANSCRIPT_TOTAL_MAX_BYTES", 2 * 1024 * 1024 * 1024),
    storageMinFreeBytes: integer("DP_STORAGE_MIN_FREE_BYTES", 256 * 1024 * 1024),
  };
  if (config.sessionOutputMaxBytes < 1) {
    throw new Error("DP_SESSION_OUTPUT_MAX_BYTES must be at least 1");
  }
  if (config.terminalMaxActive < 1) {
    throw new Error("DP_TERMINAL_MAX_ACTIVE must be at least 1");
  }
  if (BigInt(config.transcriptTotalMaxBytes) <
      BigInt(config.terminalMaxActive) * BigInt(config.sessionOutputMaxBytes)) {
    throw new Error("DP_TRANSCRIPT_TOTAL_MAX_BYTES must cover every active terminal transcript");
  }
  return config;
}

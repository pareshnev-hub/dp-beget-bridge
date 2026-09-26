import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { validateHostname } from "./host-preflight.mjs";

const FILES = ["session-host.env", "agent.env", "mcp.env"];

function safeRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value ||
      !/^\/[a-zA-Z0-9_./-]+$/.test(value) || value.split("/").includes("..")) {
    throw new Error("Unsafe allowed root");
  }
  return value;
}

export function renderCleanInstallConfig({ domain, allowedRoot, agentToken, mcpToken }) {
  domain = validateHostname(domain);
  safeRoot(allowedRoot);
  if (![agentToken, mcpToken].every(token => typeof token === "string" &&
      /^[0-9a-f]{64}$/.test(token)) || agentToken === mcpToken) {
    throw new Error("Separate random service tokens are required");
  }
  return {
    "session-host.env": `DP_SESSION_HOST_SOCKET=/run/dp-beget-bridge/session-host.sock\n` +
      `DP_SESSION_DATA_DIR=/var/lib/dp-beget-bridge\nDP_ALLOWED_ROOTS=${allowedRoot}\n` +
      `DP_TMUX_SOCKET=/var/lib/dp-beget-bridge/tmux/tmux.sock\n` +
      `DP_TERMINAL_MAX_ACTIVE=8\nDP_SESSION_OUTPUT_MAX_BYTES=67108864\n` +
      `DP_TRANSCRIPT_SEGMENT_BYTES=8388608\nDP_TRANSCRIPT_TOTAL_MAX_BYTES=2147483648\n` +
      `DP_STORAGE_MIN_FREE_BYTES=268435456\nDP_LOG_LEVEL=info\n`,
    "agent.env": `DP_AGENT_HOST=127.0.0.1\nDP_AGENT_PORT=8787\n` +
      `DP_AGENT_TOKEN=${agentToken}\n` +
      `DP_SESSION_HOST_SOCKET=/run/dp-beget-bridge/session-host.sock\n` +
      `DP_DATA_DIR=/var/lib/dp-beget-bridge-agent\nDP_ALLOWED_ROOTS=${allowedRoot}\n` +
      `DP_STORAGE_MIN_FREE_BYTES=268435456\nDP_TELEMETRY_ENABLED=false\nDP_LOG_LEVEL=info\n`,
    "mcp.env": `DP_AGENT_URL=http://127.0.0.1:8787\nDP_AGENT_TOKEN=${agentToken}\n` +
      `DP_MCP_HOST=127.0.0.1\nDP_MCP_PORT=8788\nDP_MCP_PATH=/mcp\n` +
      `DP_MCP_AUTH_MODE=static\nDP_MCP_ACCESS_TOKEN=${mcpToken}\n` +
      `DP_PUBLIC_URL=https://${domain}\nDP_LOG_LEVEL=info\n`,
  };
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// The staging directory is private to root. Installing service-readable env
// files and creating service identities belong to a journaled installer.
export async function stageCleanInstallConfig({ stageDir, domain, allowedRoot } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to stage configuration");
  if (typeof stageDir !== "string" || !path.isAbsolute(stageDir) ||
      path.normalize(stageDir) !== stageDir) throw new Error("Absolute stage directory is required");
  // Validate all user-provided values before generating and persisting secrets.
  validateHostname(domain);
  safeRoot(allowedRoot);
  const parent = path.dirname(stageDir);
  const info = await stat(parent);
  if ((await realpath(parent)) !== parent || !info.isDirectory() || info.uid !== 0 ||
      (info.mode & 0o077) !== 0) throw new Error("Configuration staging parent must be private and root-owned");
  const config = renderCleanInstallConfig({ domain, allowedRoot,
    agentToken: randomBytes(32).toString("hex"), mcpToken: randomBytes(32).toString("hex") });
  await mkdir(stageDir, { mode: 0o700 });
  try {
    for (const name of FILES) {
      const handle = await open(path.join(stageDir, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(config[name]); await handle.sync(); }
      finally { await handle.close(); }
    }
    await syncDirectory(stageDir);
    await syncDirectory(parent);
    return { files: [...FILES], mode: "private-staging" };
  } catch (error) {
    await rm(stageDir, { recursive: true, force: true });
    throw error;
  }
}

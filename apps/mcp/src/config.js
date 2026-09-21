function integer(name, fallback) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadMcpConfig() {
  return {
    host: process.env.DP_MCP_HOST || "127.0.0.1",
    port: integer("DP_MCP_PORT", 8788),
    path: process.env.DP_MCP_PATH || "/mcp",
    publicUrl: process.env.DP_PUBLIC_URL || "http://127.0.0.1:8788",
    siteUrl: process.env.DP_SITE_URL || "https://pareshnev.com/dp-beget-bridge",
    agentUrl: process.env.DP_AGENT_URL || "http://127.0.0.1:8787",
    agentToken: process.env.DP_AGENT_TOKEN || "",
    accessToken: process.env.DP_MCP_ACCESS_TOKEN || "",
    downloadTokenTtlMs: integer("DP_DOWNLOAD_TOKEN_TTL_MS", 10 * 60 * 1000),
  };
}

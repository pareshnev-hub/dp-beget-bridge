function integer(name, fallback) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function csv(name, fallback) {
  return (process.env[name] || fallback).split(",").map((value) => value.trim()).filter(Boolean);
}

export function loadMcpConfig() {
  const authMode = process.env.DP_MCP_AUTH_MODE || "static";
  if (!["static", "oauth"].includes(authMode)) throw new Error("DP_MCP_AUTH_MODE must be static or oauth");
  const publicUrl = process.env.DP_PUBLIC_URL || "http://127.0.0.1:8788";
  const mcpPath = process.env.DP_MCP_PATH || "/mcp";
  const config = {
    host: process.env.DP_MCP_HOST || "127.0.0.1",
    port: integer("DP_MCP_PORT", 8788),
    path: mcpPath,
    publicUrl,
    siteUrl: process.env.DP_SITE_URL || "https://pareshnev.com/dp-beget-bridge",
    agentUrl: process.env.DP_AGENT_URL || "http://127.0.0.1:8787",
    agentToken: process.env.DP_AGENT_TOKEN || "",
    accessToken: process.env.DP_MCP_ACCESS_TOKEN || "",
    downloadTokenTtlMs: integer("DP_DOWNLOAD_TOKEN_TTL_MS", 10 * 60 * 1000),
    attachmentFetchTimeoutMs: integer("DP_ATTACHMENT_FETCH_TIMEOUT_MS", 120000),
    attachmentMaxBytes: integer("DP_ATTACHMENT_MAX_BYTES", 64 * 1024 * 1024),
    attachmentMaxRedirects: integer("DP_ATTACHMENT_MAX_REDIRECTS", 5),
    attachmentMaxConcurrent: integer("DP_ATTACHMENT_MAX_CONCURRENT", 2),
    attachmentFetchEnabled: /^(1|true|yes)$/i.test(process.env.DP_ATTACHMENT_FETCH_ENABLED || "true"),
    authMode,
    oauth: {
      issuer: process.env.DP_OAUTH_ISSUER || publicUrl,
      resource: process.env.DP_OAUTH_RESOURCE || `${publicUrl.replace(/\/$/, "")}${mcpPath}`,
      approvalSecret: process.env.DP_OAUTH_STAGING_APPROVAL_SECRET || "",
      scopes: csv("DP_OAUTH_SCOPES", "files:read"),
      allowedClientIds: csv("DP_OAUTH_ALLOWED_CLIENT_IDS", "https://chatgpt.com/oauth/client.json"),
      transactionTtlMs: integer("DP_OAUTH_TRANSACTION_TTL_MS", 5 * 60 * 1000),
      codeTtlMs: integer("DP_OAUTH_CODE_TTL_MS", 2 * 60 * 1000),
      accessTokenTtlMs: integer("DP_OAUTH_ACCESS_TOKEN_TTL_MS", 10 * 60 * 1000),
      clientMetadataTimeoutMs: integer("DP_OAUTH_CLIENT_METADATA_TIMEOUT_MS", 5000),
    },
  };
  if (config.attachmentFetchTimeoutMs < 1 || config.attachmentMaxBytes < 1 || config.attachmentMaxConcurrent < 1) {
    throw new Error("Attachment fetch limits must be positive integers");
  }
  if (config.authMode === "oauth") {
    if (!config.publicUrl.startsWith("https://")) throw new Error("DP_PUBLIC_URL must use HTTPS in OAuth mode");
    if (config.accessToken) throw new Error("DP_MCP_ACCESS_TOKEN must be unset in OAuth mode");
    if (config.oauth.approvalSecret.length < 32) {
      throw new Error("DP_OAUTH_STAGING_APPROVAL_SECRET must contain at least 32 characters in OAuth mode");
    }
    for (const [name, value] of Object.entries({
      DP_OAUTH_TRANSACTION_TTL_MS: config.oauth.transactionTtlMs,
      DP_OAUTH_CODE_TTL_MS: config.oauth.codeTtlMs,
      DP_OAUTH_ACCESS_TOKEN_TTL_MS: config.oauth.accessTokenTtlMs,
      DP_OAUTH_CLIENT_METADATA_TIMEOUT_MS: config.oauth.clientMetadataTimeoutMs,
    })) {
      if (value < 1) throw new Error(`${name} must be a positive integer in OAuth mode`);
    }
  }
  return config;
}

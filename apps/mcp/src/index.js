import { AgentClient } from "./agent-client.js";
import { loadMcpConfig } from "./config.js";
import { DownloadTokenStore } from "./download-tokens.js";
import { createMcpHttpServer } from "./server.js";
import { createLogger } from "../../../packages/core/src/logger.js";
import { AttachmentFetcher } from "../../../packages/core/src/attachment-fetch.js";
import { AuthStore } from "../../../packages/auth/src/auth-store.js";
import { ChatGptCimdRegistry, OAuthSpike } from "../../../packages/auth/src/oauth-spike.js";

const config = loadMcpConfig();
if (!config.agentToken || config.agentToken.length < 32) throw new Error("DP_AGENT_TOKEN must contain at least 32 characters");
if (!config.accessToken && !["127.0.0.1", "::1", "localhost"].includes(config.host)) {
  throw new Error("DP_MCP_ACCESS_TOKEN is required when MCP listens on a non-loopback address");
}

const logger = createLogger("mcp", process.env.DP_LOG_LEVEL || "info");
const attachmentFetcher = config.attachmentFetchEnabled ? new AttachmentFetcher({
  timeoutMs: config.attachmentFetchTimeoutMs,
  maxBytes: config.attachmentMaxBytes,
  maxRedirects: config.attachmentMaxRedirects,
  maxConcurrent: config.attachmentMaxConcurrent,
}) : undefined;
const agent = new AgentClient({
  baseUrl: config.agentUrl,
  token: config.agentToken,
  attachmentFetcher,
  contextSecret: config.agentContextSecret,
});
const downloads = new DownloadTokenStore({ ttlMs: config.downloadTokenTtlMs });
let authStore;
let oauth;
if (config.authMode === "oauth") {
  authStore = new AuthStore(config.oauth.authDataDir, { supportedScopes: config.oauth.scopes });
  await authStore.init();
  const owner = authStore.getOwner(config.oauth.ownerId);
  if (!owner || owner.status !== "ACTIVE" || !owner.bootstrapConsumedAt) {
    authStore.close();
    throw new Error("OAuth owner bootstrap is incomplete");
  }
  oauth = new OAuthSpike({
    ...config.oauth,
    authStore,
    clientRegistry: new ChatGptCimdRegistry({
      allowedClientIds: config.oauth.allowedClientIds,
      timeoutMs: config.oauth.clientMetadataTimeoutMs,
    }),
  });
}
const server = createMcpHttpServer({ config, agent, downloads, logger, oauth });

server.listen(config.port, config.host, () => {
  logger.info("mcp.started", { port: config.port, route: "/mcp" });
});

function shutdown(signal) {
  logger.info("mcp.stopping", { signal });
  server.close(() => {
    authStore?.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

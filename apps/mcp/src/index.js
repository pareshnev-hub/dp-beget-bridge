import { AgentClient } from "./agent-client.js";
import { loadMcpConfig } from "./config.js";
import { DownloadTokenStore } from "./download-tokens.js";
import { createMcpHttpServer } from "./server.js";
import { createLogger } from "../../../packages/core/src/logger.js";

const config = loadMcpConfig();
if (!config.agentToken || config.agentToken.length < 32) throw new Error("DP_AGENT_TOKEN must contain at least 32 characters");
if (!config.accessToken && !["127.0.0.1", "::1", "localhost"].includes(config.host)) {
  throw new Error("DP_MCP_ACCESS_TOKEN is required when MCP listens on a non-loopback address");
}

const logger = createLogger("mcp", process.env.DP_LOG_LEVEL || "info");
const agent = new AgentClient({ baseUrl: config.agentUrl, token: config.agentToken });
const downloads = new DownloadTokenStore({ ttlMs: config.downloadTokenTtlMs });
const server = createMcpHttpServer({ config, agent, downloads, logger });

server.listen(config.port, config.host, () => {
  logger.info("mcp.started", { port: config.port, route: "/mcp" });
});

function shutdown(signal) {
  logger.info("mcp.stopping", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

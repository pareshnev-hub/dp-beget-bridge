import fs from "node:fs/promises";
import { loadConfig } from "./config.js";
import { StateStore } from "./state-store.js";
import { TmuxSessionManager } from "./tmux.js";
import { FileManager } from "./files.js";
import { createAgentServer } from "./server.js";
import { PathPolicy } from "../../../packages/core/src/path-policy.js";
import { createLogger } from "../../../packages/core/src/logger.js";
import { loadOrCreateInstallationId, TelemetryClient } from "./telemetry.js";

const config = loadConfig();
const logger = createLogger("agent");

if (!config.token || config.token.length < 32) {
  logger.error("agent.invalid_config", { message: "DP_AGENT_TOKEN must contain at least 32 characters" });
  process.exit(1);
}

await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
const store = new StateStore(config.dataDir);
await store.init();
const installationId = await loadOrCreateInstallationId(config.dataDir);
const telemetry = new TelemetryClient({
  enabled: config.telemetryEnabled,
  endpoint: config.telemetryUrl,
  installationId,
  logger,
});
const pathPolicy = new PathPolicy(config.allowedRoots);
const sessions = new TmuxSessionManager({ config, store, pathPolicy, logger, telemetry });
const files = new FileManager({ pathPolicy, logger, telemetry, uploadMaxBytes: config.fileUploadMaxBytes });
const server = createAgentServer({ config, sessions, files, logger });

server.listen(config.port, config.host, () => {
  logger.info("agent.started", {
    agentId: config.agentId,
    host: config.host,
    port: config.port,
    allowedRoots: config.allowedRoots,
  });
  telemetry.track("service_started", { version: "0.1.0", platform: process.platform, arch: process.arch });
});

function shutdown(signal) {
  logger.info("agent.stopping", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

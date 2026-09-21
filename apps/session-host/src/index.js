import fs from "node:fs/promises";
import path from "node:path";
import { loadSessionHostConfig } from "./config.js";
import { createSessionHostServer } from "./server.js";
import { StateStore } from "../../agent/src/state-store.js";
import { TmuxSessionManager } from "../../agent/src/tmux.js";
import { PathPolicy } from "../../../packages/core/src/path-policy.js";
import { createLogger } from "../../../packages/core/src/logger.js";

const config = loadSessionHostConfig();
const logger = createLogger("session-host", process.env.DP_LOG_LEVEL || "info");

if (process.env.DP_AGENT_TOKEN || process.env.DP_MCP_ACCESS_TOKEN) {
  throw new Error("Session Host refuses to start with Agent or MCP credentials in its environment");
}

await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
await fs.mkdir(path.dirname(config.socketPath), { recursive: true, mode: 0o750 });
await fs.rm(config.socketPath, { force: true });

const store = new StateStore(config.dataDir);
await store.init();
const sessions = new TmuxSessionManager({
  config,
  store,
  pathPolicy: new PathPolicy(config.allowedRoots),
  logger,
  telemetry: { track() {}, trackActivity() {} },
});
const server = createSessionHostServer({ sessions, logger });

server.listen(config.socketPath, async () => {
  await fs.chmod(config.socketPath, 0o660);
  logger.info("session_host.started", { allowedRootCount: config.allowedRoots.length });
});

function shutdown(signal) {
  logger.info("session_host.stopping", { signal });
  server.close(async () => {
    await fs.rm(config.socketPath, { force: true }).catch(() => {});
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

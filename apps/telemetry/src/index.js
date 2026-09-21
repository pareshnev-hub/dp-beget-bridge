import { createLogger } from "../../../packages/core/src/logger.js";
import { loadTelemetryConfig } from "./config.js";
import { createTelemetryServer } from "./server.js";
import { AggregateStore } from "./store.js";

const config = loadTelemetryConfig();
if (config.hashSecret.length < 32) throw new Error("DP_TELEMETRY_HASH_SECRET must contain at least 32 characters");
const logger = createLogger("telemetry");
const store = new AggregateStore(config);
await store.init();
const server = createTelemetryServer({ store, logger });
server.listen(config.port, config.host, () => logger.info("telemetry.started", { host: config.host, port: config.port }));

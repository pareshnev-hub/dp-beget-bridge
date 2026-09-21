import path from "node:path";

function integer(name, fallback) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadTelemetryConfig() {
  return {
    host: process.env.DP_TELEMETRY_HOST || "127.0.0.1",
    port: integer("DP_TELEMETRY_PORT", 8790),
    dataDir: path.resolve(process.env.DP_TELEMETRY_DATA_DIR || "./runtime/telemetry"),
    hashSecret: process.env.DP_TELEMETRY_HASH_SECRET || "",
    retentionDays: integer("DP_TELEMETRY_RETENTION_DAYS", 90),
  };
}

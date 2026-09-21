import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const ALLOWED_FIELDS = Object.freeze({
  service_started: ["version", "platform", "arch"],
  active_day: [],
  terminal_opened: [],
  terminal_closed: ["durationBucket"],
  file_transferred: ["direction", "sizeBucket"],
});

export function durationBucket(milliseconds) {
  const minutes = milliseconds / 60000;
  if (minutes < 1) return "under_1m";
  if (minutes < 5) return "1_5m";
  if (minutes < 30) return "5_30m";
  if (minutes < 120) return "30_120m";
  return "over_2h";
}

export function sizeBucket(bytes) {
  if (bytes < 1024 * 1024) return "under_1mb";
  if (bytes < 10 * 1024 * 1024) return "1_10mb";
  if (bytes < 100 * 1024 * 1024) return "10_100mb";
  if (bytes < 1024 * 1024 * 1024) return "100mb_1gb";
  return "over_1gb";
}

export async function loadOrCreateInstallationId(dataDir) {
  const destination = path.join(dataDir, "installation-id");
  try {
    return (await fs.readFile(destination, "utf8")).trim();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const id = crypto.randomUUID();
  await fs.writeFile(destination, `${id}\n`, { mode: 0o600, flag: "wx" });
  return id;
}

export class TelemetryClient {
  constructor({ enabled, endpoint, installationId, logger, fetchImpl = fetch }) {
    this.enabled = enabled;
    this.endpoint = endpoint;
    this.installationId = installationId;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.lastActivityDay = null;
  }

  trackActivity() {
    const day = new Date().toISOString().slice(0, 10);
    if (day === this.lastActivityDay) return;
    this.lastActivityDay = day;
    this.track("active_day");
  }

  track(event, fields = {}) {
    if (!this.enabled || !this.endpoint || !(event in ALLOWED_FIELDS)) return;
    const safe = {};
    for (const key of ALLOWED_FIELDS[event]) {
      if (fields[key] !== undefined) safe[key] = fields[key];
    }
    const payload = {
      schemaVersion: 1,
      installationId: this.installationId,
      event,
      occurredAt: new Date().toISOString(),
      ...safe,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    timer.unref?.();
    this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "DP-Beget-Bridge/0.1.0" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).catch((error) => {
      this.logger.debug("telemetry.delivery_failed", { message: error.message });
    }).finally(() => clearTimeout(timer));
  }
}

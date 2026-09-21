const EVENTS = new Set(["service_started", "active_day", "terminal_opened", "terminal_closed", "file_transferred"]);
const DURATIONS = new Set(["under_1m", "1_5m", "5_30m", "30_120m", "over_2h"]);
const SIZES = new Set(["under_1mb", "1_10mb", "10_100mb", "100mb_1gb", "over_1gb"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Event must be an object");
  if (input.schemaVersion !== 1) throw new Error("Unsupported schema version");
  if (!UUID.test(input.installationId || "")) throw new Error("Invalid installation ID");
  if (!EVENTS.has(input.event)) throw new Error("Unknown event");
  const occurredAt = new Date(input.occurredAt);
  if (!Number.isFinite(occurredAt.getTime())) throw new Error("Invalid event time");
  if (Math.abs(Date.now() - occurredAt.getTime()) > 7 * 86400000) throw new Error("Event time is outside the accepted window");

  const result = {
    schemaVersion: 1,
    installationId: input.installationId,
    event: input.event,
    occurredAt: occurredAt.toISOString(),
  };
  if (input.event === "service_started") {
    for (const key of ["version", "platform", "arch"]) {
      if (typeof input[key] !== "string" || input[key].length > 40) throw new Error(`Invalid ${key}`);
      result[key] = input[key];
    }
  }
  if (input.event === "terminal_closed") {
    if (!DURATIONS.has(input.durationBucket)) throw new Error("Invalid duration bucket");
    result.durationBucket = input.durationBucket;
  }
  if (input.event === "file_transferred") {
    if (!new Set(["upload", "download"]).has(input.direction)) throw new Error("Invalid transfer direction");
    if (!SIZES.has(input.sizeBucket)) throw new Error("Invalid size bucket");
    result.direction = input.direction;
    result.sizeBucket = input.sizeBucket;
  }
  return result;
}

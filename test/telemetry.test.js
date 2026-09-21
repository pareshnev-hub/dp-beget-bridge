import assert from "node:assert/strict";
import test from "node:test";
import { durationBucket, sizeBucket, TelemetryClient } from "../apps/agent/src/telemetry.js";

const logger = { debug() {} };

test("telemetry sends only allowlisted fields", async () => {
  const payloads = [];
  const client = new TelemetryClient({
    enabled: true,
    endpoint: "https://example.test/events",
    installationId: "anonymous-installation-id",
    logger,
    fetchImpl: async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return { ok: true };
    },
  });
  client.track("terminal_closed", {
    durationBucket: "5_30m",
    command: "must not leave the VPS",
    path: "/private/path",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].durationBucket, "5_30m");
  assert.equal("command" in payloads[0], false);
  assert.equal("path" in payloads[0], false);
});

test("activity is reported at most once per process day", async () => {
  let count = 0;
  const client = new TelemetryClient({
    enabled: true,
    endpoint: "https://example.test/events",
    installationId: "id",
    logger,
    fetchImpl: async () => { count += 1; return { ok: true }; },
  });
  client.trackActivity();
  client.trackActivity();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(count, 1);
});

test("buckets avoid exact usage measurements", () => {
  assert.equal(durationBucket(90_000), "1_5m");
  assert.equal(sizeBucket(2 * 1024 * 1024), "1_10mb");
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateEvent } from "../apps/telemetry/src/schema.js";
import { AggregateStore } from "../apps/telemetry/src/store.js";

test("collector validates and strips unknown sensitive fields", () => {
  const event = validateEvent({
    schemaVersion: 1,
    installationId: crypto.randomUUID(),
    event: "terminal_closed",
    occurredAt: new Date().toISOString(),
    durationBucket: "5_30m",
    command: "do not retain",
    path: "/do/not/retain",
  });
  assert.equal(event.durationBucket, "5_30m");
  assert.equal("command" in event, false);
  assert.equal("path" in event, false);
});

test("collector stores daily aggregates and a keyed installation hash", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-aggregate-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new AggregateStore({ dataDir, hashSecret: "s".repeat(32), retentionDays: 90 });
  await store.init();
  const installationId = crypto.randomUUID();
  const event = {
    schemaVersion: 1,
    installationId,
    event: "active_day",
    occurredAt: new Date().toISOString(),
  };
  const aggregate = await store.record(event);
  assert.equal(aggregate.events.active_day, 1);
  assert.equal(aggregate.uniqueInstallations.length, 1);
  assert.notEqual(aggregate.uniqueInstallations[0], installationId);
  const stored = await fs.readFile(path.join(dataDir, `${event.occurredAt.slice(0, 10)}.json`), "utf8");
  assert.equal(stored.includes(installationId), false);
});

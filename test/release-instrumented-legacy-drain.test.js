import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { advanceMigrationJournal, startMigrationJournal } from "../scripts/release/migration-journal.mjs";
import { assertInstrumentedLegacyDrain } from "../scripts/release/assert-instrumented-legacy-drain.mjs";
import { legacyActivityFixture, unitBackupFixture } from "./fixtures/unit-backup.js";

const WRITERS = new Set(["dp-beget-agent.service", "dp-beget-mcp.service",
  "dp-beget-mcp-oauth-spike.service", "dp-beget-session-host.service"]);

async function setup(t) {
  const { root, backupDir } = await unitBackupFixture(t);
  const journalPath = path.join(root, "migration.json");
  await startMigrationJournal(journalPath, { oldCommit: "a".repeat(40),
    newCommit: "b".repeat(40), artifactSha256: "c".repeat(64),
    unitBackupDir: backupDir, inspectServices: legacyActivityFixture });
  await advanceMigrationJournal(journalPath, "prepared", "guarded");
  await advanceMigrationJournal(journalPath, "guarded", "ingress-closed");
  const calls = { route: 0, health: 0, wait: 0 };
  const options = { journalPath, verifyClosedMarker: async () => {},
    assertRouteExclusive: async () => { calls.route++; return true; },
    wait: async ms => { assert.equal(ms, 1000); calls.wait++; },
    readUnit: async unit => ({ LoadState: "loaded", ActiveState: WRITERS.has(unit) ? "active" : "inactive",
      MainPID: WRITERS.has(unit) ? "42" : "0" }),
    readHealth: async ({ requireCounters }) => {
      assert.equal(requireCounters, true);
      calls.health++;
      return { services: 4, inFlightRequests: [0, 0, 0, 0] };
    } };
  return { options, calls };
}

test("stable four-service counters and closed dedicated ingress prove bounded drain", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { options, calls } = await setup(t);
  assert.equal(await assertInstrumentedLegacyDrain(options), true);
  assert.deepEqual(calls, { route: 2, health: 2, wait: 1 });
});

test("absent counter, active work, a restart or changing route fails closed", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { options } = await setup(t);
  await assert.rejects(assertInstrumentedLegacyDrain({ ...options,
    readHealth: async () => ({ services: 4 }) }), /counter evidence/);
  await assert.rejects(assertInstrumentedLegacyDrain({ ...options,
    readHealth: async () => ({ services: 4, inFlightRequests: [0, 1, 0, 0] }) }),
  /requests are active/);
  let calls = 0;
  await assert.rejects(assertInstrumentedLegacyDrain({ ...options,
    readUnit: async unit => ({ LoadState: "loaded", ActiveState: WRITERS.has(unit) ? "active" : "inactive",
      MainPID: WRITERS.has(unit) ? (calls++ < 4 ? "42" : "43") : "0" }) }),
  /boundary changed/);
  let routeCalls = 0;
  await assert.rejects(assertInstrumentedLegacyDrain({ ...options,
    assertRouteExclusive: async () => ++routeCalls === 1 }), /boundary changed/);
});

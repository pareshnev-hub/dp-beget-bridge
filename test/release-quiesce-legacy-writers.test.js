import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeLegacyIngress } from "../scripts/release/close-legacy-ingress.mjs";
import { readMigrationJournal, advanceMigrationJournal, startMigrationJournal } from "../scripts/release/migration-journal.mjs";
import { quiesceLegacyWriters } from "../scripts/release/quiesce-legacy-writers.mjs";
import { legacyActivityFixture, unitBackupFixture } from "./fixtures/unit-backup.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-quiesce-journal-"));
  const markerRoot = await mkdtemp("/var/lib/dp-quiesce-test-");
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(markerRoot, { recursive: true, force: true }));
  const { backupDir } = await unitBackupFixture(t);
  const journalPath = path.join(root, "journal.json");
  const marker = path.join(markerRoot, "migration-incomplete");
  const stateDatabase = path.join(root, "state.sqlite");
  await startMigrationJournal(journalPath, { oldCommit: "a".repeat(40), newCommit: "b".repeat(40),
    artifactSha256: "c".repeat(64), unitBackupDir: backupDir,
    inspectServices: legacyActivityFixture });
  await advanceMigrationJournal(journalPath, "prepared", "guarded");
  const stopped = [];
  await closeLegacyIngress({ journalPath, marker, unitDirectory: "/etc/systemd/system",
    inspectGuard: async () => true, inspectServices: legacyActivityFixture,
    stopUnit: async unit => { stopped.push(unit); },
    getState: async unit => stopped.includes(unit) ? "inactive" : "active" });
  return { journalPath, marker, stateDatabase, stopped };
}

test("OPS-07: quiescence proves drained requests and safe ledger before Session Host stop", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { journalPath, marker, stateDatabase, stopped } = await fixture(t);
  const steps = [];
  const result = await quiesceLegacyWriters({ journalPath, marker, stateDatabase,
    assertNoInFlight: async () => { steps.push("drained"); },
    getKillMode: async () => "process",
    stopUnit: async unit => {
      assert.equal((await readMigrationJournal(journalPath)).phase, "quiesced");
      steps.push(unit); stopped.push(unit);
    },
    getState: async unit => stopped.includes(unit) ? "inactive" : "active",
    assertLedgerSafe: async () => { steps.push("ledger-safe"); } });
  assert.equal(result.stopped.length, 4);
  assert.equal(steps[0], "drained");
  assert.deepEqual(steps.slice(-2), ["ledger-safe", "dp-beget-session-host.service"]);
  assert.match(await readFile(marker, "utf8"), /migration-incomplete/);
});

test("OPS-07: failed ledger leaves ingress closed and Session Host running", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { journalPath, marker, stateDatabase, stopped } = await fixture(t);
  await assert.rejects(quiesceLegacyWriters({ journalPath, marker, stateDatabase,
    assertNoInFlight: async () => {}, getKillMode: async () => "process",
    stopUnit: async unit => { stopped.push(unit); },
    getState: async unit => stopped.includes(unit) ? "inactive" : "active",
    assertLedgerSafe: async () => { throw new Error("accepted operation remains"); } }),
  /accepted operation remains/);
  assert.equal(stopped.includes("dp-beget-session-host.service"), false);
  assert.equal((await readMigrationJournal(journalPath)).phase, "quiesced");
  assert.match(await readFile(marker, "utf8"), /migration-incomplete/);
});

test("OPS-07: missing drain proof refuses to stop writers", { skip: process.getuid?.() !== 0 }, async t => {
  const { journalPath, marker, stateDatabase } = await fixture(t);
  await assert.rejects(quiesceLegacyWriters({ journalPath, marker, stateDatabase }),
    /independent in-flight proof/);
  assert.equal((await readMigrationJournal(journalPath)).phase, "ingress-closed");
});

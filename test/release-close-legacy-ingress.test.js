import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeLegacyIngress } from "../scripts/release/close-legacy-ingress.mjs";
import { advanceMigrationJournal, readMigrationJournal, startMigrationJournal } from "../scripts/release/migration-journal.mjs";
import { legacyActivityFixture, unitBackupFixture } from "./fixtures/unit-backup.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-close-journal-"));
  const markerRoot = await mkdtemp("/var/lib/dp-close-test-");
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(markerRoot, { recursive: true, force: true }));
  const { backupDir } = await unitBackupFixture(t);
  const journalPath = path.join(root, "journal.json");
  const marker = path.join(markerRoot, "migration-incomplete");
  await startMigrationJournal(journalPath, { oldCommit: "a".repeat(40), newCommit: "b".repeat(40),
    artifactSha256: "c".repeat(64), unitBackupDir: backupDir,
    inspectServices: legacyActivityFixture });
  await advanceMigrationJournal(journalPath, "prepared", "guarded");
  return { journalPath, marker };
}

test("OPS-07: durable marker and journal phase precede dedicated ingress stops", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { journalPath, marker } = await fixture(t);
  const stopped = [];
  const result = await closeLegacyIngress({ journalPath, marker, unitDirectory: "/etc/systemd/system",
    inspectGuard: async () => true,
    inspectServices: legacyActivityFixture,
    stopUnit: async unit => {
      assert.equal((await readMigrationJournal(journalPath)).phase, "ingress-closed");
      assert.match(await readFile(marker, "utf8"), /migration-incomplete/);
      stopped.push(unit);
    },
    getState: async unit => stopped.includes(unit) ? "inactive" : "active" });
  assert.deepEqual(result.closed, ["dp-beget-oauth-proxy.socket", "dp-beget-oauth-proxy.service",
    "dp-beget-tunnel.service"]);
  assert.equal((await stat(marker)).mode & 0o777, 0o600);
  await assert.rejects(closeLegacyIngress({ journalPath, marker, inspectGuard: async () => true }),
    /verified the installed guard/);
});

test("OPS-07: failed stop leaves marker and journal for recovery", { skip: process.getuid?.() !== 0 }, async t => {
  const { journalPath, marker } = await fixture(t);
  await assert.rejects(closeLegacyIngress({ journalPath, marker, unitDirectory: "/etc/systemd/system",
    inspectGuard: async () => true, inspectServices: legacyActivityFixture, stopUnit: async unit => {
      if (unit === "dp-beget-oauth-proxy.service") throw new Error("stop failed");
    } }), /stop failed/);
  assert.equal((await readMigrationJournal(journalPath)).phase, "ingress-closed");
  assert.match(await readFile(marker, "utf8"), /migration-incomplete/);
});

test("OPS-07: changed service inventory fails before writing marker", { skip: process.getuid?.() !== 0 }, async t => {
  const { journalPath, marker } = await fixture(t);
  await assert.rejects(closeLegacyIngress({ journalPath, marker, unitDirectory: "/etc/systemd/system",
    inspectGuard: async () => true, inspectServices: async () => ({ ...await legacyActivityFixture(),
      "dp-beget-oauth-proxy.service": "active" }) }), /activity changed/);
  await assert.rejects(readFile(marker), /ENOENT/);
  assert.equal((await readMigrationJournal(journalPath)).phase, "guarded");
});

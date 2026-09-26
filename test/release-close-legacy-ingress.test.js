import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    assertRouteExclusive: async () => true,
    inspectGuard: async () => true,
    inspectWriterGuards: async () => true,
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
  await assert.rejects(closeLegacyIngress({ journalPath, marker, inspectGuard: async () => true,
    assertRouteExclusive: async () => true }),
    /verified the installed guard/);
});

test("OPS-07: failed stop leaves marker and journal for recovery", { skip: process.getuid?.() !== 0 }, async t => {
  const { journalPath, marker } = await fixture(t);
  await assert.rejects(closeLegacyIngress({ journalPath, marker, unitDirectory: "/etc/systemd/system",
    assertRouteExclusive: async () => true,
    inspectGuard: async () => true, inspectServices: legacyActivityFixture, stopUnit: async unit => {
      if (unit === "dp-beget-oauth-proxy.service") throw new Error("stop failed");
    }, inspectWriterGuards: async () => true }), /stop failed/);
  assert.equal((await readMigrationJournal(journalPath)).phase, "ingress-closed");
  assert.match(await readFile(marker, "utf8"), /migration-incomplete/);
});

test("OPS-07: changed service inventory fails before writing marker", { skip: process.getuid?.() !== 0 }, async t => {
  const { journalPath, marker } = await fixture(t);
  await assert.rejects(closeLegacyIngress({ journalPath, marker, unitDirectory: "/etc/systemd/system",
    assertRouteExclusive: async () => true,
    inspectGuard: async () => true, inspectWriterGuards: async () => true,
    inspectServices: async () => ({ ...await legacyActivityFixture(),
      "dp-beget-oauth-proxy.service": "active" }) }), /activity changed/);
  await assert.rejects(readFile(marker), /ENOENT/);
  assert.equal((await readMigrationJournal(journalPath)).phase, "guarded");
});

test("OPS-07: route change during stops retains persistent guard and refuses closed result", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { journalPath, marker } = await fixture(t);
  const stopped = [];
  let proofs = 0;
  await assert.rejects(closeLegacyIngress({ journalPath, marker,
    unitDirectory: "/etc/systemd/system", inspectGuard: async () => true,
    inspectWriterGuards: async () => true, inspectServices: legacyActivityFixture,
    assertRouteExclusive: async () => ++proofs === 1,
    stopUnit: async unit => { stopped.push(unit); },
    getState: async unit => stopped.includes(unit) ? "inactive" : "active" }),
  /route changed during ingress closure/);
  assert.equal(proofs, 2);
  assert.equal(stopped.length, 3);
  assert.equal((await readMigrationJournal(journalPath)).phase, "ingress-closed");
  assert.match(await readFile(marker, "utf8"), /migration-incomplete/);
});

test("OPS-07: missing writer guard or stale writer start permit blocks ingress closure", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { journalPath, marker } = await fixture(t);
  await assert.rejects(closeLegacyIngress({ journalPath, marker, inspectGuard: async () => true,
    assertRouteExclusive: async () => true,
    inspectWriterGuards: async () => { throw new Error("writer guard missing"); } }), /writer guard missing/);
  const permitRoot = await mkdtemp("/run/dp-close-permit-");
  t.after(() => rm(permitRoot, { recursive: true, force: true }));
  const permit = path.join(permitRoot, "writer-start-allowed");
  await writeFile(permit, "stale\n");
  await assert.rejects(closeLegacyIngress({ journalPath, marker, permit,
    assertRouteExclusive: async () => true,
    inspectGuard: async () => true, inspectWriterGuards: async () => true }), /permit remains active/);
  await assert.rejects(readFile(marker), /ENOENT/);
});

test("OPS-07: route proof fails closed before any migration marker or stop", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { journalPath, marker } = await fixture(t);
  let stops = 0;
  const options = { journalPath, marker, unitDirectory: "/etc/systemd/system",
    inspectGuard: async () => true, inspectWriterGuards: async () => true,
    inspectServices: legacyActivityFixture, stopUnit: async () => { stops++; } };
  await assert.rejects(closeLegacyIngress(options), /Explicit fresh public OAuth route proof/);
  await assert.rejects(closeLegacyIngress({ ...options,
    assertRouteExclusive: async () => false }), /Exclusive public OAuth route not proven/);
  await assert.rejects(closeLegacyIngress({ ...options,
    assertRouteExclusive: async () => { throw new Error("route changed"); } }), /route changed/);
  assert.equal(stops, 0);
  await assert.rejects(readFile(marker), /ENOENT/);
  assert.equal((await readMigrationJournal(journalPath)).phase, "guarded");
});

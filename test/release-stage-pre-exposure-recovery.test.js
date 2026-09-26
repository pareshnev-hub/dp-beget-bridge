import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { backupStateBundle } from "../scripts/release/backup-state-bundle.mjs";
import { preparePreExposureRollback, readPreparedRollbackIntent, verifyPreparedRollbackIntent } from
  "../scripts/release/prepare-pre-exposure-rollback.mjs";
import { stageCompletePreExposureRecovery } from "../scripts/release/stage-complete-pre-exposure-recovery.mjs";
import { advanceMigrationJournal, readMigrationJournal, startMigrationJournal } from "../scripts/release/migration-journal.mjs";
import { readOriginalUnitViewRecord, restoreOriginalUnitView } from
  "../scripts/release/restore-original-unit-view.mjs";
import { MANAGED_APP_UNITS, MANAGED_DROP_IN, managedUnitContent } from
  "../scripts/release/stage-managed-unit-overrides.mjs";
import { WRITER_GUARD_DROP_IN, writerGuardContent } from "../scripts/release/writer-boot-guard.mjs";
import { stagePreExposureRecovery } from "../scripts/release/stage-pre-exposure-recovery.mjs";
import { readCandidateRollbackStopRecord, stopCandidateForRollback, verifyCandidateRollbackStopped } from
  "../scripts/release/stop-candidate-for-rollback.mjs";
import { verifyStagedRecoveryPair } from "../scripts/release/verify-staged-recovery-pair.mjs";
import { verifyOriginalUnitViewRestored } from "../scripts/release/verify-original-unit-view.mjs";
import { readLiveStateCopyRecord, stageLiveStateRecovery, verifyPreparedLiveStateCopies } from
  "../scripts/release/stage-live-state-recovery.mjs";
import { inspectLiveReplacementLedger, prepareLiveReplacementLedger, replaceLiveStateFromLedger } from
  "../scripts/release/live-state-replacement-ledger.mjs";
import { deactivateCandidatePointer, readCandidatePointerRollbackRecord } from
  "../scripts/release/deactivate-candidate-pointer.mjs";
import { readLegacyRestartRecord, restartLegacyAfterRollback } from
  "../scripts/release/restart-legacy-after-rollback.mjs";
import { legacyActivityFixture, unitBackupFixture } from "./fixtures/unit-backup.js";

async function fixture(t, phase = "locally-healthy") {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-stage-recovery-"));
  const markerRoot = await mkdtemp("/var/lib/dp-stage-recovery-");
  const permitRoot = await mkdtemp("/run/dp-stage-recovery-");
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(markerRoot, { recursive: true, force: true }));
  t.after(() => rm(permitRoot, { recursive: true, force: true }));
  const marker = path.join(markerRoot, "migration-incomplete");
  await writeFile(marker, "dp-beget-bridge-migration-incomplete-v1\n", { mode: 0o600 });
  const configRoot = path.join(root, "config");
  await mkdir(configRoot, { mode: 0o700 });
  await writeFile(path.join(configRoot, "secret.env"), "CANARY=private\n", { mode: 0o600 });
  const database = path.join(root, "legacy.sqlite");
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE state (value TEXT)");
  db.prepare("INSERT INTO state VALUES (?)").run("old-state");
  db.close();
  const snapshotPath = path.join(root, "snapshot");
  await backupStateBundle({ configRoot, databases: [{ name: "legacy", source: database }],
    outputDir: snapshotPath, assertQuiesced: async () => {} });
  const snapshotSha256 = createHash("sha256").update(await readFile(path.join(snapshotPath,
    "bundle-manifest.json"))).digest("hex");
  const { backupDir } = await unitBackupFixture(t);
  const journalPath = path.join(root, "journal.json");
  await startMigrationJournal(journalPath, { oldCommit: "a".repeat(40), newCommit: "b".repeat(40),
    artifactSha256: "c".repeat(64), unitBackupDir: backupDir, inspectServices: legacyActivityFixture });
  for (const [before, after] of [["prepared", "guarded"], ["guarded", "ingress-closed"],
    ["ingress-closed", "quiesced"]]) await advanceMigrationJournal(journalPath, before, after);
  await advanceMigrationJournal(journalPath, "quiesced", "snapshotted", { snapshotPath, snapshotSha256 });
  if (["switched", "locally-healthy", "ingress-open"].includes(phase)) {
    await advanceMigrationJournal(journalPath, "snapshotted", "switched");
  }
  if (["locally-healthy", "ingress-open"].includes(phase)) {
    await advanceMigrationJournal(journalPath, "switched", "locally-healthy");
  }
  if (phase === "ingress-open") await advanceMigrationJournal(journalPath, "locally-healthy", "ingress-open");
  return { journalPath, marker, snapshotPath, configRoot, database, outputDir: path.join(root, "restored"),
    permit: path.join(permitRoot, "writer-start-allowed"),
    inspectGuard: async () => {}, inspectWriterGuards: async () => {},
    getState: async () => "inactive", assertRouteExclusive: async () => true };
}

test("OPS-07: pre-exposure staging verifies real grouped state without changing live data", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  const result = await stagePreExposureRecovery(options);
  assert.deepEqual(result.databases, ["legacy"]);
  assert.equal(result.sources.databases[0].name, "legacy");
  assert.equal(path.isAbsolute(result.sources.databases[0].path), true);
  assert.equal(await readFile(path.join(options.outputDir, "config", "secret.env"), "utf8"), "CANARY=private\n");
  const db = new DatabaseSync(path.join(options.outputDir, "sqlite", "legacy.sqlite"), { readOnly: true });
  try { assert.equal(db.prepare("SELECT value FROM state").get().value, "old-state"); }
  finally { db.close(); }
  assert.match(await readFile(options.marker, "utf8"), /migration-incomplete/);
});

test("OPS-07: exposure intent forbids old-state staging even if marker was recreated", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t, "ingress-open");
  await assert.rejects(stagePreExposureRecovery(options), /rewind is forbidden/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: route failure and changed ingress state block recovery before copying", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await assert.rejects(stagePreExposureRecovery({ ...options, assertRouteExclusive: async () => false }),
    /route not proven/);
  await assert.rejects(stagePreExposureRecovery({ ...options, getState: async () => "active" }),
    /Ingress remains active/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: a route change after copying removes staged state", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  let calls = 0;
  await assert.rejects(stagePreExposureRecovery({ ...options,
    assertRouteExclusive: async () => ++calls === 1 }), /route not proven/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: recovery staging requires writer boot guards in the journaled unit phase", {
  skip: process.getuid?.() !== 0
}, async t => {
  for (const [phase, managed] of [["snapshotted", false], ["switched", true], ["locally-healthy", true]]) {
    const options = await fixture(t, phase);
    let checks = 0;
    await stagePreExposureRecovery({ ...options,
      inspectWriterGuards: async args => { assert.equal(args.managed, managed); checks++; } });
    assert.equal(checks, 2);
  }
});

test("OPS-07: missing writer guard or leftover permit blocks recovery before copy", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await assert.rejects(stagePreExposureRecovery({ ...options,
    inspectWriterGuards: async () => { throw new Error("writer guard not loaded"); } }),
  /writer guard not loaded/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
  await writeFile(options.permit, "unexpected permit\n");
  await assert.rejects(stagePreExposureRecovery(options), /permit remains active/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: writer guard change after copy removes staged state", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  let checks = 0;
  await assert.rejects(stagePreExposureRecovery({ ...options,
    inspectWriterGuards: async () => {
      if (++checks === 2) throw new Error("writer guard changed");
    } }), /writer guard changed/);
  assert.equal(checks, 2);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: permit appearing during recovery removes staged state", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await assert.rejects(stagePreExposureRecovery({ ...options,
    restore: async args => {
      const { restoreStateBundle } = await import("../scripts/release/restore-state-bundle.mjs");
      const result = await restoreStateBundle(args);
      await writeFile(options.permit, "unexpected permit\n");
      return result;
    } }), /permit remains active/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: stages matching old state and original systemd units together", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  const result = await stageCompletePreExposureRecovery(options);
  assert.equal(result.transactionId, result.state.transactionId);
  assert.equal(result.units.files, 7);
  assert.equal(result.destinations.databases[0].path, options.database);
  assert.equal(await readFile(path.join(result.directory, "state", "config", "secret.env"), "utf8"),
    "CANARY=private\n");
  assert.match(await readFile(path.join(result.directory, "units", "dp-beget-session-host.service"), "utf8"),
    /Description=dp-beget-session-host.service/);
  const reopened = await verifyStagedRecoveryPair(options);
  assert.equal(reopened.transactionId, result.transactionId);
  assert.equal(reopened.destinations.databases[0].ino, result.destinations.databases[0].ino);
});

test("OPS-07: changed staged SQLite or original unit bytes refuse later recovery", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await stageCompletePreExposureRecovery(options);
  const stagedSqlite = path.join(options.outputDir, "state", "sqlite", "legacy.sqlite");
  await writeFile(stagedSqlite, "altered database\n");
  await assert.rejects(verifyStagedRecoveryPair(options), /Staged recovery file metadata changed|Staged recovery file changed/);
  const { restoreStateBundle } = await import("../scripts/release/restore-state-bundle.mjs");
  await rm(path.join(options.outputDir, "state"), { recursive: true });
  await restoreStateBundle({ backupDir: options.snapshotPath,
    outputDir: path.join(options.outputDir, "state") });
  await writeFile(path.join(options.outputDir, "units", "dp-beget-agent.service"), "altered unit\n");
  await assert.rejects(verifyStagedRecoveryPair(options), /Staged recovery file metadata changed|Staged recovery file changed/);
});

test("OPS-07: reopened pair refuses a lost closed-ingress boundary", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await stageCompletePreExposureRecovery(options);
  await assert.rejects(verifyStagedRecoveryPair({ ...options, getState: async () => "active" }),
    /Ingress remains active/);
});

test("OPS-07: reopened pair detects an extra staged config file and route drift", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await stageCompletePreExposureRecovery(options);
  const staged = path.join(options.outputDir, "state", "config", "extra.env");
  await writeFile(staged, "UNEXPECTED=1\n");
  await assert.rejects(verifyStagedRecoveryPair(options), /Staged recovery inventory changed/);
  await rm(staged);
  let proofs = 0;
  await assert.rejects(verifyStagedRecoveryPair({ ...options,
    assertRouteExclusive: async () => ++proofs === 1 }), /route not proven/);
  assert.equal(proofs, 2);
});

test("OPS-07: durable rollback intent binds the staged pair and live destination inodes", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await stageCompletePreExposureRecovery(options);
  const planPath = path.join(path.dirname(options.outputDir), "rollback-intent.json");
  const intent = await preparePreExposureRollback({ ...options,
    stagedDirectory: options.outputDir, planPath });
  assert.equal(intent.phase, "prepared");
  assert.equal(intent.destinations.databases[0].path, options.database);
  assert.deepEqual(await verifyPreparedRollbackIntent({ ...options, planPath }), intent);
  assert.deepEqual(await readPreparedRollbackIntent(planPath), intent);
});

test("OPS-07: altered staged data invalidates a previously recorded rollback intent", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await stageCompletePreExposureRecovery(options);
  const planPath = path.join(path.dirname(options.outputDir), "rollback-intent.json");
  await preparePreExposureRollback({ ...options, stagedDirectory: options.outputDir, planPath });
  await writeFile(path.join(options.outputDir, "state", "config", "secret.env"), "tampered\n");
  await assert.rejects(verifyPreparedRollbackIntent({ ...options, planPath }),
    /Staged recovery file metadata changed|Staged recovery file changed/);
});

test("OPS-07: failed route proof cannot create intent or overwrite an existing one", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await stageCompletePreExposureRecovery(options);
  const planPath = path.join(path.dirname(options.outputDir), "rollback-intent.json");
  await assert.rejects(preparePreExposureRollback({ ...options,
    stagedDirectory: options.outputDir, planPath,
    assertRouteExclusive: async () => false }), /route not proven/);
  await assert.rejects(stat(planPath), /ENOENT/);
  await writeFile(planPath, "keep\n");
  await assert.rejects(preparePreExposureRollback({ ...options,
    stagedDirectory: options.outputDir, planPath }), /EEXIST/);
  assert.equal(await readFile(planPath, "utf8"), "keep\n");
});

test("OPS-07: candidate writers stop under durable rollback intent before state replacement", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await stageCompletePreExposureRecovery(options);
  const planPath = path.join(path.dirname(options.outputDir), "rollback-intent.json");
  const stopRecordPath = path.join(path.dirname(options.outputDir), "candidate-stop.json");
  await preparePreExposureRollback({ ...options, stagedDirectory: options.outputDir, planPath });
  const stopped = [];
  let ledgerCalls = 0;
  const result = await stopCandidateForRollback({ ...options, planPath, stopRecordPath,
    stateDatabase: options.database, getIngressState: options.getState,
    getState: async unit => stopped.includes(unit) ? "inactive" : "active",
    getKillMode: async () => "process", assertPaused: async () => {}, verifyPaused: async () => {},
    assertLedgerSafe: async () => { ledgerCalls++; assert.equal(stopped.length, ledgerCalls === 1 ? 3 : 4); },
    stopUnit: async unit => {
      assert.equal((await readCandidateRollbackStopRecord(stopRecordPath)).phase, "stopping");
      stopped.push(unit);
    } });
  assert.equal(ledgerCalls, 2);
  assert.equal(result.phase, "stopped");
  assert.deepEqual(result.stoppedUnits, stopped);
  assert.equal(stopped.at(-1), "dp-beget-session-host.service");
  await assert.rejects(verifyCandidateRollbackStopped({ ...options, planPath, stopRecordPath,
    stateDatabase: options.database, getIngressState: options.getState,
    getState: async unit => unit === "dp-beget-mcp.service" ? "active" : "inactive",
    verifyPaused: async () => {}, assertLedgerSafe: async () => {} }), /writer restarted/);
});

test("OPS-07: ledger failure leaves candidate stop intent uncertain and ingress closed", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await stageCompletePreExposureRecovery(options);
  const planPath = path.join(path.dirname(options.outputDir), "rollback-intent.json");
  const stopRecordPath = path.join(path.dirname(options.outputDir), "candidate-stop.json");
  await preparePreExposureRollback({ ...options, stagedDirectory: options.outputDir, planPath });
  const stopped = [];
  await assert.rejects(stopCandidateForRollback({ ...options, planPath, stopRecordPath,
    stateDatabase: options.database, getIngressState: options.getState,
    getState: async unit => stopped.includes(unit) ? "inactive" : "active",
    getKillMode: async () => "process", assertPaused: async () => {}, verifyPaused: async () => {},
    assertLedgerSafe: async () => { throw new Error("accepted operation remains"); },
    stopUnit: async unit => { stopped.push(unit); } }), /accepted operation remains/);
  assert.equal(stopped.length, 3);
  assert.equal((await readCandidateRollbackStopRecord(stopRecordPath)).phase, "stopping");
  assert.match(await readFile(options.marker, "utf8"), /migration-incomplete/);
});

test("OPS-07: missing R0004 pause refuses candidate stop before recording intent", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await stageCompletePreExposureRecovery(options);
  const planPath = path.join(path.dirname(options.outputDir), "rollback-intent.json");
  const stopRecordPath = path.join(path.dirname(options.outputDir), "candidate-stop.json");
  await preparePreExposureRollback({ ...options, stagedDirectory: options.outputDir, planPath });
  await assert.rejects(stopCandidateForRollback({ ...options, planPath, stopRecordPath,
    stateDatabase: options.database, getIngressState: options.getState,
    verifyPaused: async () => { throw new Error("R0004 admission pause missing"); },
    stopUnit: async () => { throw new Error("must not stop"); } }), /admission pause missing/);
  await assert.rejects(stat(stopRecordPath), /ENOENT/);
});

async function originalUnitViewFixture(t) {
  const options = await fixture(t);
  await stageCompletePreExposureRecovery(options);
  const root = path.dirname(options.outputDir);
  const planPath = path.join(root, "rollback-intent.json");
  const stopRecordPath = path.join(root, "candidate-stop.json");
  const unitRecordPath = path.join(root, "original-unit-view.json");
  await preparePreExposureRollback({ ...options, stagedDirectory: options.outputDir, planPath });
  const stopped = [];
  await stopCandidateForRollback({ ...options, planPath, stopRecordPath,
    stateDatabase: options.database, getIngressState: options.getState,
    getState: async unit => stopped.includes(unit) ? "inactive" : "active",
    getKillMode: async () => "process", assertPaused: async () => {}, verifyPaused: async () => {},
    assertLedgerSafe: async () => {}, stopUnit: async unit => { stopped.push(unit); } });
  const releaseRoot = path.join(root, "releases");
  const unitDirectory = path.join(root, "live-units");
  await mkdir(unitDirectory);
  const journal = await readMigrationJournal(options.journalPath);
  for (const unit of MANAGED_APP_UNITS) {
    await copyFile(path.join(journal.unitBackup.path, "files", unit), path.join(unitDirectory, unit));
    const directory = path.join(unitDirectory, `${unit}.d`);
    await mkdir(directory);
    if (unit === "dp-beget-mcp-oauth-spike.service") {
      await writeFile(path.join(directory, "10-dp012-dcr.conf"), "[Service]\n");
    }
    await writeFile(path.join(directory, WRITER_GUARD_DROP_IN),
      writerGuardContent(options.marker, options.permit));
    await writeFile(path.join(directory, MANAGED_DROP_IN), managedUnitContent(releaseRoot));
  }
  return { ...options, planPath, stopRecordPath, unitRecordPath, releaseRoot, unitDirectory,
    stateDatabase: options.database, getIngressState: options.getState,
    getState: async () => "inactive", verifyPaused: async () => {}, assertLedgerSafe: async () => {},
    getWriterState: async () => "inactive",
    inspectManaged: async () => {}, inspectWriterGuards: async () => {} };
}

test("OPS-07: original unit view removes only managed bindings after stopped proof", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await originalUnitViewFixture(t);
  const result = await restoreOriginalUnitView({ ...options, reload: async () => {} });
  assert.equal(result.phase, "restored");
  assert.deepEqual(result.units, MANAGED_APP_UNITS);
  for (const unit of MANAGED_APP_UNITS) {
    const directory = path.join(options.unitDirectory, `${unit}.d`);
    await assert.rejects(stat(path.join(directory, MANAGED_DROP_IN)), /ENOENT/);
    assert.match(await readFile(path.join(directory, WRITER_GUARD_DROP_IN), "utf8"), /ConditionPathExists/);
  }
  const proof = await verifyOriginalUnitViewRestored(options);
  assert.equal(proof.transactionId, (await readMigrationJournal(options.journalPath)).transactionId);
  assert.equal(proof.destinations.databases[0].path, options.database);
});

test("OPS-07: original view proof rejects incomplete record, restarted writer and changed state", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await originalUnitViewFixture(t);
  await assert.rejects(verifyOriginalUnitViewRestored(options), /ENOENT/);
  await restoreOriginalUnitView({ ...options, reload: async () => {} });
  await assert.rejects(verifyOriginalUnitViewRestored({ ...options,
    getWriterState: async unit => unit === "dp-beget-agent.service" ? "active" : "inactive" }),
  /Writer restarted/);
  await writeFile(path.join(options.outputDir, "state", "config", "secret.env"), "changed\n");
  await assert.rejects(verifyOriginalUnitViewRestored(options), /Staged recovery file/);
});

test("OPS-07: original view proof rejects lost guard or changed unit fragment", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await originalUnitViewFixture(t);
  await restoreOriginalUnitView({ ...options, reload: async () => {} });
  await assert.rejects(verifyOriginalUnitViewRestored({ ...options,
    inspectWriterGuards: async () => { throw new Error("writer guard missing"); } }),
  /writer guard missing/);
  await writeFile(path.join(options.unitDirectory, "dp-beget-agent.service.d", MANAGED_DROP_IN), "stale\n");
  await assert.rejects(verifyOriginalUnitViewRestored(options), /drop-in inventory changed/);
  await rm(path.join(options.unitDirectory, "dp-beget-agent.service.d", MANAGED_DROP_IN));
  await writeFile(path.join(options.unitDirectory, "dp-beget-agent.service"), "changed\n");
  await assert.rejects(verifyOriginalUnitViewRestored(options), /legacy app units differ/);
});

test("OPS-07: destination-local recovery copies leave live state untouched", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await originalUnitViewFixture(t);
  await restoreOriginalUnitView({ ...options, reload: async () => {} });
  const recordPath = path.join(path.dirname(options.outputDir), "live-copy-record.json");
  const before = await stat(options.database);
  const record = await stageLiveStateRecovery({ ...options, recordPath });
  assert.equal(record.phase, "prepared");
  assert.equal((await readLiveStateCopyRecord(recordPath)).phase, "prepared");
  assert.equal((await readFile(path.join(record.configCopy, "secret.env"), "utf8")), "CANARY=private\n");
  const copied = new DatabaseSync(record.databases[0].copy, { readOnly: true });
  try { assert.equal(copied.prepare("SELECT value FROM state").get().value, "old-state"); }
  finally { copied.close(); }
  assert.equal((await stat(options.database)).ino, before.ino);
  await verifyPreparedLiveStateCopies({ ...options, recordPath });
  await writeFile(path.join(record.configCopy, "secret.env"), "tampered\n");
  await assert.rejects(verifyPreparedLiveStateCopies({ ...options, recordPath }),
    /Prepared configuration file changed/);
});

test("OPS-07: failed recovery copy retains copying intent and original live data", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await originalUnitViewFixture(t);
  await restoreOriginalUnitView({ ...options, reload: async () => {} });
  const recordPath = path.join(path.dirname(options.outputDir), "live-copy-record.json");
  const before = await readFile(options.database);
  await assert.rejects(stageLiveStateRecovery({ ...options, recordPath,
    copyDatabase: async () => { throw new Error("copy interrupted"); } }), /copy interrupted/);
  assert.equal((await readLiveStateCopyRecord(recordPath)).phase, "copying");
  assert.deepEqual(await readFile(options.database), before);
  await assert.rejects(verifyPreparedLiveStateCopies({ ...options, recordPath }), /incomplete/);
});

test("OPS-07: replacement ledger identifies each interrupted rename without opening ingress", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await originalUnitViewFixture(t);
  await restoreOriginalUnitView({ ...options, reload: async () => {} });
  const root = path.dirname(options.outputDir);
  const recordPath = path.join(root, "live-copy-record.json");
  const ledgerPath = path.join(root, "replacement-ledger.json");
  await stageLiveStateRecovery({ ...options, recordPath });
  const ledger = await prepareLiveReplacementLedger({ ...options, recordPath, ledgerPath });
  assert.deepEqual((await inspectLiveReplacementLedger({ ...options, ledgerPath })).positions,
    ["pending", "pending"]);
  await writeFile(ledgerPath, JSON.stringify({ ...ledger, phase: "replacing" }) + "\n");
  await rename(ledger.targets[0].live, ledger.targets[0].parked);
  assert.deepEqual((await inspectLiveReplacementLedger({ ...options, ledgerPath })).positions,
    ["parked", "pending"]);
  await rename(ledger.targets[0].copy, ledger.targets[0].live);
  await rename(ledger.targets[1].live, ledger.targets[1].parked);
  assert.deepEqual((await inspectLiveReplacementLedger({ ...options, ledgerPath })).positions,
    ["installed", "parked"]);
  await rename(ledger.targets[1].copy, ledger.targets[1].live);
  assert.deepEqual((await inspectLiveReplacementLedger({ ...options, ledgerPath })).positions,
    ["installed", "installed"]);
  assert.match(await readFile(options.marker, "utf8"), /migration-incomplete/);
});

test("OPS-07: changed prepared database refuses replacement ledger inspection", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await originalUnitViewFixture(t);
  await restoreOriginalUnitView({ ...options, reload: async () => {} });
  const root = path.dirname(options.outputDir);
  const recordPath = path.join(root, "live-copy-record.json");
  const ledgerPath = path.join(root, "replacement-ledger.json");
  const copies = await stageLiveStateRecovery({ ...options, recordPath });
  await prepareLiveReplacementLedger({ ...options, recordPath, ledgerPath });
  await writeFile(copies.databases[0].copy, "corrupt\n");
  await assert.rejects(inspectLiveReplacementLedger({ ...options, ledgerPath }),
    /Replacement copy changed/);
  await copyFile(path.join(options.outputDir, "state", "sqlite", "legacy.sqlite"),
    copies.databases[0].copy);
  const mode = (await stat(copies.databases[0].copy)).mode & 0o777;
  await chmod(copies.databases[0].copy, mode === 0o600 ? 0o640 : 0o600);
  await assert.rejects(inspectLiveReplacementLedger({ ...options, ledgerPath }),
    /Replacement ownership changed/);
});

test("OPS-07: replacement ledger cannot be placed inside its staged recovery pair", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await originalUnitViewFixture(t);
  await restoreOriginalUnitView({ ...options, reload: async () => {} });
  const recordPath = path.join(path.dirname(options.outputDir), "live-copy-record.json");
  await stageLiveStateRecovery({ ...options, recordPath });
  await assert.rejects(prepareLiveReplacementLedger({ ...options, recordPath,
    ledgerPath: path.join(options.outputDir, "replacement-ledger.json") }),
  /outside staged/);
});

test("OPS-07: journaled live replacement restores old state and parks candidate bytes", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await originalUnitViewFixture(t);
  await restoreOriginalUnitView({ ...options, reload: async () => {} });
  await writeFile(path.join(options.configRoot, "secret.env"), "CANARY=candidate\n");
  const candidate = new DatabaseSync(options.database);
  candidate.prepare("UPDATE state SET value = ?").run("candidate-state");
  candidate.close();
  const root = path.dirname(options.outputDir);
  const recordPath = path.join(root, "live-copy-record.json");
  const ledgerPath = path.join(root, "replacement-ledger.json");
  await stageLiveStateRecovery({ ...options, recordPath });
  const ledger = await prepareLiveReplacementLedger({ ...options, recordPath, ledgerPath });
  const result = await replaceLiveStateFromLedger({ ...options, ledgerPath });
  assert.equal(result.record.phase, "replaced");
  assert.deepEqual(result.positions, ["installed", "installed"]);
  assert.equal(await readFile(path.join(options.configRoot, "secret.env"), "utf8"), "CANARY=private\n");
  assert.equal(await readFile(path.join(ledger.targets[0].parked, "secret.env"), "utf8"),
    "CANARY=candidate\n");
  const restored = new DatabaseSync(options.database, { readOnly: true });
  const parked = new DatabaseSync(ledger.targets[1].parked, { readOnly: true });
  try {
    assert.equal(restored.prepare("SELECT value FROM state").get().value, "old-state");
    assert.equal(parked.prepare("SELECT value FROM state").get().value, "candidate-state");
  } finally { restored.close(); parked.close(); }
  assert.match(await readFile(options.marker, "utf8"), /migration-incomplete/);
  assert.deepEqual((await replaceLiveStateFromLedger({ ...options, ledgerPath })).positions,
    ["installed", "installed"]);
});

test("OPS-07: interrupted first rename resumes only from recognized parked inode", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await originalUnitViewFixture(t);
  await restoreOriginalUnitView({ ...options, reload: async () => {} });
  const root = path.dirname(options.outputDir);
  const recordPath = path.join(root, "live-copy-record.json");
  const ledgerPath = path.join(root, "replacement-ledger.json");
  await stageLiveStateRecovery({ ...options, recordPath });
  await prepareLiveReplacementLedger({ ...options, recordPath, ledgerPath });
  await assert.rejects(replaceLiveStateFromLedger({ ...options, ledgerPath,
    renameEntry: async (...args) => { await rename(...args); throw new Error("power interrupted"); } }),
  /power interrupted/);
  const interrupted = await inspectLiveReplacementLedger({ ...options, ledgerPath });
  assert.equal(interrupted.record.phase, "replacing");
  assert.deepEqual(interrupted.positions, ["parked", "pending"]);
  assert.deepEqual((await replaceLiveStateFromLedger({ ...options, ledgerPath })).positions,
    ["installed", "installed"]);
});

test("OPS-07: interruption after installing config resumes remaining database", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await originalUnitViewFixture(t);
  await restoreOriginalUnitView({ ...options, reload: async () => {} });
  const root = path.dirname(options.outputDir);
  const recordPath = path.join(root, "live-copy-record.json");
  const ledgerPath = path.join(root, "replacement-ledger.json");
  await stageLiveStateRecovery({ ...options, recordPath });
  await prepareLiveReplacementLedger({ ...options, recordPath, ledgerPath });
  let renames = 0;
  await assert.rejects(replaceLiveStateFromLedger({ ...options, ledgerPath,
    renameEntry: async (...args) => {
      await rename(...args);
      if (++renames === 2) throw new Error("interrupted after config installation");
    } }), /interrupted after config installation/);
  assert.deepEqual((await inspectLiveReplacementLedger({ ...options, ledgerPath })).positions,
    ["installed", "pending"]);
  assert.deepEqual((await replaceLiveStateFromLedger({ ...options, ledgerPath })).positions,
    ["installed", "installed"]);
});

async function completedReplacementFixture(t) {
  const options = await originalUnitViewFixture(t);
  await restoreOriginalUnitView({ ...options, reload: async () => {} });
  const root = path.dirname(options.outputDir);
  const recordPath = path.join(root, "live-copy-record.json");
  const ledgerPath = path.join(root, "replacement-ledger.json");
  const pointerRecordPath = path.join(root, "pointer-rollback.json");
  await stageLiveStateRecovery({ ...options, recordPath });
  await prepareLiveReplacementLedger({ ...options, recordPath, ledgerPath });
  await replaceLiveStateFromLedger({ ...options, ledgerPath });
  await mkdir(options.releaseRoot);
  await mkdir(path.join(options.releaseRoot, "releases"));
  const versionDir = `1.0.0-${"b".repeat(40)}`;
  await mkdir(path.join(options.releaseRoot, "releases", versionDir));
  await writeFile(path.join(options.releaseRoot, "releases", versionDir, "package.json"),
    JSON.stringify({ name: "dp-beget-bridge", version: "1.0.0" }));
  await symlink(`releases/${versionDir}`, path.join(options.releaseRoot, "current"));
  return { ...options, ledgerPath, pointerRecordPath, versionDir };
}

test("OPS-07: first-migration candidate pointer is removed only after old state replacement", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await completedReplacementFixture(t);
  const result = await deactivateCandidatePointer({ ...options, recordPath: options.pointerRecordPath });
  assert.equal(result.phase, "removed");
  await assert.rejects(stat(path.join(options.releaseRoot, "current")), /ENOENT/);
  assert.match(await readFile(options.marker, "utf8"), /migration-incomplete/);
  assert.equal((await deactivateCandidatePointer({ ...options,
    recordPath: options.pointerRecordPath })).phase, "removed");
});

test("OPS-07: interrupted pointer unlink resumes from durable removing intent", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await completedReplacementFixture(t);
  await assert.rejects(deactivateCandidatePointer({ ...options, recordPath: options.pointerRecordPath,
    unlinkPointer: async filename => { await rm(filename); throw new Error("interrupted after unlink"); } }),
  /interrupted after unlink/);
  assert.equal((await readCandidatePointerRollbackRecord(options.pointerRecordPath)).phase, "removing");
  assert.equal((await deactivateCandidatePointer({ ...options,
    recordPath: options.pointerRecordPath })).phase, "removed");
});

test("OPS-07: changed first-migration pointer or previous release blocks rollback", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await completedReplacementFixture(t);
  await symlink(`releases/${options.versionDir}`, path.join(options.releaseRoot, "previous"));
  await assert.rejects(deactivateCandidatePointer({ ...options,
    recordPath: options.pointerRecordPath }), /no previous release/);
  await assert.rejects(stat(options.pointerRecordPath), /ENOENT/);
});

test("OPS-07: pointer rollback record cannot alter recovered configuration", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await completedReplacementFixture(t);
  const unsafe = path.join(options.configRoot, "pointer-rollback.json");
  await assert.rejects(deactivateCandidatePointer({ ...options, recordPath: unsafe }),
    /outside live state/);
  await assert.rejects(stat(unsafe), /ENOENT/);
});

async function legacyRestartFixture(t) {
  const options = await completedReplacementFixture(t);
  await deactivateCandidatePointer({ ...options, recordPath: options.pointerRecordPath });
  const active = new Set();
  return { ...options, recordPath: path.join(path.dirname(options.outputDir), "legacy-restart.json"),
    pointerRecordPath: options.pointerRecordPath,
    getState: async unit => active.has(unit) ? "active" : "inactive",
    startUnit: async unit => { active.add(unit); },
    withPermit: async ({ action }) => action(),
    assertLegacyHealthy: async () => ({ services: 4, products: ["DP Beget Bridge",
      "DP Beget Bridge", "DP Beget Bridge", "DP Beget Bridge Session Host"] }),
    active };
}

test("OPS-07: original services restart in order after data and pointer rollback", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await legacyRestartFixture(t);
  const order = [];
  const result = await restartLegacyAfterRollback({ ...options, startUnit: async unit => {
    options.active.add(unit); order.push(unit);
  } });
  assert.equal(result.phase, "started");
  assert.deepEqual(order, ["dp-beget-session-host.service", "dp-beget-agent.service",
    "dp-beget-mcp.service", "dp-beget-mcp-oauth-spike.service"]);
  assert.match(await readFile(options.marker, "utf8"), /migration-incomplete/);
  assert.equal((await restartLegacyAfterRollback(options)).phase, "started");
});

test("OPS-07: interrupted old-service startup resumes only an active prefix", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await legacyRestartFixture(t);
  await assert.rejects(restartLegacyAfterRollback({ ...options, startUnit: async unit => {
    options.active.add(unit);
    if (unit === "dp-beget-agent.service") throw new Error("service start interrupted");
  } }), /service start interrupted/);
  assert.equal((await readLegacyRestartRecord(options.recordPath)).phase, "starting");
  assert.equal((await restartLegacyAfterRollback(options)).phase, "started");
});

test("OPS-07: candidate health never certifies restored R0003 services", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await legacyRestartFixture(t);
  await assert.rejects(restartLegacyAfterRollback({ ...options,
    assertLegacyHealthy: async () => ({ services: 4, products: ["wrong"] }) }),
  /Four exact R0003/);
  assert.equal((await readLegacyRestartRecord(options.recordPath)).phase, "starting");
  assert.equal((await restartLegacyAfterRollback(options)).phase, "started");
});

test("OPS-07: restart record cannot alter restored configuration", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await legacyRestartFixture(t);
  const unsafe = path.join(options.configRoot, "legacy-restart.json");
  await assert.rejects(restartLegacyAfterRollback({ ...options, recordPath: unsafe }),
    /outside live state/);
  await assert.rejects(stat(unsafe), /ENOENT/);
});

test("OPS-07: daemon-reload failure retains restoring intent and ingress marker", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await originalUnitViewFixture(t);
  await assert.rejects(restoreOriginalUnitView({ ...options,
    reload: async () => { throw new Error("systemd reload failed"); } }), /systemd reload failed/);
  assert.equal((await readOriginalUnitViewRecord(options.unitRecordPath)).phase, "restoring");
  assert.match(await readFile(options.marker, "utf8"), /migration-incomplete/);
});

test("OPS-07: a writer restart after reload blocks restored unit claim", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await originalUnitViewFixture(t);
  await assert.rejects(restoreOriginalUnitView({ ...options, reload: async () => {},
    getWriterState: async unit => unit === "dp-beget-agent.service" ? "active" : "inactive" }),
  /Writer restarted during unit recovery/);
  assert.equal((await readOriginalUnitViewRecord(options.unitRecordPath)).phase, "restoring");
});

test("OPS-07: changed original fragment blocks unit recovery before writing intent", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await originalUnitViewFixture(t);
  await writeFile(path.join(options.unitDirectory, "dp-beget-agent.service"), "tampered\n");
  await assert.rejects(restoreOriginalUnitView({ ...options, reload: async () => {} }),
    /legacy app units differ/);
  await assert.rejects(stat(options.unitRecordPath), /ENOENT/);
});

test("OPS-07: a route change after both restorations removes the entire staged pair", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  let proofs = 0;
  await assert.rejects(stageCompletePreExposureRecovery({ ...options,
    assertRouteExclusive: async () => ++proofs < 3 }), /route not proven/);
  assert.equal(proofs, 3);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: failed unit restoration removes staged state as a single pair", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await assert.rejects(stageCompletePreExposureRecovery({ ...options,
    stageUnits: async () => { throw new Error("original unit backup changed"); } }),
  /original unit backup changed/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: mismatched live configuration removes the staged state and units", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await writeFile(path.join(options.configRoot, "candidate.env"), "NEW=1\n");
  await assert.rejects(stageCompletePreExposureRecovery(options), /configuration inventory differs/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: a live SQLite sidecar blocks the complete recovery pair", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await writeFile(`${options.database}-wal`, "pending changes\n");
  await assert.rejects(stageCompletePreExposureRecovery(options), /sidecar needs explicit recovery/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: possible public exposure forbids combined old-state staging", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t, "ingress-open");
  await assert.rejects(stageCompletePreExposureRecovery(options), /forbidden after possible public exposure/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

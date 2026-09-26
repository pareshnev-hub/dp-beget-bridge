import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createPersistentMarker } from "../scripts/release/close-legacy-ingress.mjs";
import { advanceMigrationJournal, readMigrationJournal, startMigrationJournal } from "../scripts/release/migration-journal.mjs";
import { recoverFirstMigration } from "../scripts/release/recover-first-migration.mjs";
import { legacyActivityFixture, unitBackupFixture } from "./fixtures/unit-backup.js";

const oldCommit = "a".repeat(40);
const newCommit = "b".repeat(40);
const artifactSha256 = "c".repeat(64);

async function setup(t) {
  const { backupDir } = await unitBackupFixture(t);
  const root = await mkdtemp("/var/lib/dp-first-rollback-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const journalPath = path.join(root, "migration.json");
  const marker = path.join(root, "migration-incomplete");
  const snapshot = path.join(root, "snapshot");
  await mkdir(snapshot, { mode: 0o700 });
  const bytes = Buffer.from("{}\n");
  await writeFile(path.join(snapshot, "bundle-manifest.json"), bytes, { mode: 0o600 });
  await startMigrationJournal(journalPath, { oldCommit, newCommit, artifactSha256,
    unitBackupDir: backupDir, inspectServices: legacyActivityFixture });
  await advanceMigrationJournal(journalPath, "prepared", "guarded");
  await advanceMigrationJournal(journalPath, "guarded", "ingress-closed");
  await advanceMigrationJournal(journalPath, "ingress-closed", "quiesced");
  await advanceMigrationJournal(journalPath, "quiesced", "snapshotted", {
    snapshotPath: snapshot, snapshotSha256: createHash("sha256").update(bytes).digest("hex") });
  await advanceMigrationJournal(journalPath, "snapshotted", "switched");
  await advanceMigrationJournal(journalPath, "switched", "locally-healthy");
  await createPersistentMarker(marker);
  const names = ["recoveryRoot", "planPath", "stopRecordPath", "unitRecordPath",
    "copyRecordPath", "ledgerPath", "pointerRecordPath", "restartRecordPath", "ingressRecordPath"];
  return { journalPath, marker, unitDirectory: root, releaseRoot: path.join(root, "release"),
    versionDir: `0.1.0-${newCommit}`, assertRouteExclusive: async () => true,
    ...Object.fromEntries(names.map(name => [name, path.join(root, name)])) };
}

function fakePhases(args, transactionId, calls, failAt) {
  const run = name => async options => {
    calls.push(name);
    if (name === failAt) throw new Error("injected rollback failure");
    if (name === "reopenIngress") {
      assert.equal(options.recordPath, args.ingressRecordPath);
      await advanceMigrationJournal(args.journalPath, "locally-healthy", "ingress-open");
    }
    if (name === "stage") return { transactionId, phase: "locally-healthy", directory: args.recoveryRoot };
  };
  return {
    stage: run("stage"), prepare: run("prepare"), stopCandidate: run("stopCandidate"),
    restoreUnits: run("restoreUnits"), stageCopies: run("stageCopies"),
    prepareLedger: run("prepareLedger"), replaceState: run("replaceState"),
    deactivate: run("deactivate"), restartLegacy: run("restartLegacy"), reopenIngress: run("reopenIngress"),
    readIntent: async () => ({ migrationTransactionId: transactionId, phase: "prepared",
      journalPath: args.journalPath, stagedDirectory: args.recoveryRoot }),
    readStop: async () => ({ migrationTransactionId: transactionId, phase: "stopped",
      planPath: args.planPath }),
    readUnits: async () => ({ migrationTransactionId: transactionId, phase: "restored" }),
    readCopies: async () => ({ migrationTransactionId: transactionId, phase: "prepared",
      planPath: args.planPath, stopRecordPath: args.stopRecordPath,
      unitRecordPath: args.unitRecordPath }),
    readLedger: async () => ({ migrationTransactionId: transactionId,
      phase: calls.includes("replaceState") ? "replaced" : "prepared", copyRecordPath: args.copyRecordPath }),
    readPointer: async () => ({ migrationTransactionId: transactionId, phase: "removed",
      ledgerPath: args.ledgerPath, releaseRoot: args.releaseRoot }),
    readRestart: async () => ({ migrationTransactionId: transactionId, phase: "started",
      pointerRecordPath: args.pointerRecordPath }),
    readIngress: async () => ({ migrationTransactionId: transactionId, phase: "exposed",
      restartRecordPath: args.restartRecordPath })
  };
}

test("pre-exposure rollback orders every durable phase and records public exposure last", {
  skip: process.getuid?.() !== 0
}, async t => {
  const args = await setup(t);
  const transactionId = (await readMigrationJournal(args.journalPath)).transactionId;
  const calls = [];
  const result = await recoverFirstMigration({ ...args, ...fakePhases(args, transactionId, calls) });
  assert.equal(result.phase, "ingress-open");
  assert.deepEqual(calls, ["stage", "prepare", "stopCandidate", "restoreUnits", "stageCopies",
    "prepareLedger", "replaceState", "deactivate", "restartLegacy", "reopenIngress"]);
});

test("a failed state replacement stops before pointer removal and public ingress", {
  skip: process.getuid?.() !== 0
}, async t => {
  const args = await setup(t);
  const transactionId = (await readMigrationJournal(args.journalPath)).transactionId;
  const calls = [];
  await assert.rejects(recoverFirstMigration({ ...args,
    ...fakePhases(args, transactionId, calls, "replaceState") }), /injected rollback failure/);
  assert.equal((await readMigrationJournal(args.journalPath)).phase, "locally-healthy");
  assert.ok(!calls.includes("reopenIngress"));
});

test("a possibly exposed migration is refused before any old-state rewind", {
  skip: process.getuid?.() !== 0
}, async t => {
  const args = await setup(t);
  await advanceMigrationJournal(args.journalPath, "locally-healthy", "ingress-open");
  const calls = [];
  await assert.rejects(recoverFirstMigration({ ...args,
    ...fakePhases(args, (await readMigrationJournal(args.journalPath)).transactionId, calls) }),
  /Only an unexposed/);
  assert.deepEqual(calls, []);
});

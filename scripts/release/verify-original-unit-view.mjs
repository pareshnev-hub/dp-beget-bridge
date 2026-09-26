import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertSessionHostRestartSafe } from "../deploy/session-host-restart-preflight.mjs";
import { verifyAdmissionPause } from "./admission-pause.mjs";
import { assertOriginalAppUnits } from "./install-managed-overrides.mjs";
import { inspectInstalledWriterGuards } from "./installed-writer-guard-preflight.mjs";
import { readMigrationJournal } from "./migration-journal.mjs";
import { readPreparedRollbackIntent } from "./prepare-pre-exposure-rollback.mjs";
import { readOriginalUnitViewRecord } from "./restore-original-unit-view.mjs";
import { readCandidateRollbackStopRecord } from "./stop-candidate-for-rollback.mjs";
import { readRegularFile } from "./verify-artifact.mjs";
import { assertPreExposureRecoveryBoundary } from "./stage-pre-exposure-recovery.mjs";
import { verifyStagedRecoveryPair } from "./verify-staged-recovery-pair.mjs";
import { MANAGED_APP_UNITS } from "./stage-managed-unit-overrides.mjs";
import { WRITER_GUARD_DROP_IN } from "./writer-boot-guard.mjs";
import { DEFAULT_ADMISSION_PAUSE_PATH } from "../../packages/core/src/admission-gate.js";

const WRITERS = ["dp-beget-mcp-oauth-spike.service", "dp-beget-mcp.service",
  "dp-beget-agent.service", "dp-beget-session-host.service"];
const exec = promisify(execFile);
async function systemctlState(unit) {
  const { stdout } = await exec("systemctl", ["show", unit, "--property=ActiveState", "--no-pager"],
    { timeout: 5000, maxBuffer: 4096 });
  if (!/^ActiveState=[a-z-]+\n$/.test(stdout)) throw new Error(`Invalid writer state: ${unit}`);
  return stdout.trim().slice("ActiveState=".length);
}
async function assertOriginalDropIns(unitDirectory) {
  for (const unit of MANAGED_APP_UNITS) {
    const directory = path.join(unitDirectory, `${unit}.d`);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
        (await realpath(directory)) !== directory) throw new Error(`Untrusted original drop-ins: ${unit}`);
    const expected = unit === "dp-beget-mcp-oauth-spike.service"
      ? ["10-dp012-dcr.conf", WRITER_GUARD_DROP_IN].sort() : [WRITER_GUARD_DROP_IN];
    if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expected)) {
      throw new Error(`Original unit drop-in inventory changed: ${unit}`);
    }
  }
}

// The ordinary staged-pair verifier expects managed bindings in a
// locally-healthy migration. Once the original view is restored, prove the
// durable transition and then inspect the pair against the original view.
// This is a read-only prerequisite for later live state replacement.
export async function verifyOriginalUnitViewBoundary({ planPath, stopRecordPath, unitRecordPath,
  stateDatabase, unitDirectory = "/etc/systemd/system",
  admissionFlag = DEFAULT_ADMISSION_PAUSE_PATH,
  verifyPaused = verifyAdmissionPause, assertLedgerSafe = assertSessionHostRestartSafe,
  getWriterState = systemctlState, inspectWriterGuards = inspectInstalledWriterGuards,
  ...boundary } = {}) {
  if (process.getuid?.() !== 0 || ![planPath, stopRecordPath, unitRecordPath, stateDatabase].every(
    filename => path.isAbsolute(filename || "") && path.normalize(filename) === filename) ||
      !path.isAbsolute(unitDirectory || "") || path.normalize(unitDirectory) !== unitDirectory ||
      !path.isAbsolute(admissionFlag || "") || path.normalize(admissionFlag) !== admissionFlag ||
      new Set([planPath, stopRecordPath, unitRecordPath]).size !== 3 ||
      typeof boundary.assertRouteExclusive !== "function") {
    throw new Error("Root, recovery records, stopped writer proof and route proof are required");
  }
  const intent = await readPreparedRollbackIntent(planPath);
  const journal = await readMigrationJournal(intent.journalPath);
  const stop = await readCandidateRollbackStopRecord(stopRecordPath);
  const restored = await readOriginalUnitViewRecord(unitRecordPath);
  if (intent.migrationPhase !== "locally-healthy" || journal.phase !== intent.migrationPhase ||
      journal.transactionId !== intent.migrationTransactionId ||
      journal.snapshotSha256 !== intent.bundleManifestSha256 ||
      journal.unitBackup.manifestSha256 !== intent.unitManifestSha256 ||
      stop.phase !== "stopped" || stop.planPath !== planPath ||
      stop.migrationTransactionId !== journal.transactionId ||
      stop.intentSha256 !== createHash("sha256").update(await readRegularFile(planPath, 16 * 1024)).digest("hex") ||
      restored.phase !== "restored" || restored.migrationTransactionId !== journal.transactionId ||
      restored.unitManifestSha256 !== journal.unitBackup.manifestSha256 ||
      restored.stopRecordSha256 !== createHash("sha256").update(await readRegularFile(stopRecordPath, 4096)).digest("hex")) {
    throw new Error("Original unit view is not bound to a completed candidate stop and migration");
  }
  for (const filename of [planPath, stopRecordPath, unitRecordPath]) {
    if ([intent.stagedDirectory, journal.snapshotPath, journal.unitBackup.path, unitDirectory].some(
      directory => filename === directory || filename.startsWith(`${directory}${path.sep}`))) {
      throw new Error("Recovery records must be outside staged, backup and live unit directories");
    }
  }
  const stagedInfo = await lstat(intent.stagedDirectory);
  if (stagedInfo.dev !== intent.stagedDev || stagedInfo.ino !== intent.stagedIno ||
      (await realpath(intent.stagedDirectory)) !== intent.stagedDirectory) {
    throw new Error("Staged recovery pair changed since intent");
  }
  await verifyPaused({ flag: admissionFlag });
  for (const unit of WRITERS) {
    if (await getWriterState(unit) !== "inactive") throw new Error(`Writer restarted after unit recovery: ${unit}`);
  }
  await assertLedgerSafe(stateDatabase);
  await assertOriginalAppUnits(journal, unitDirectory);
  await assertOriginalDropIns(unitDirectory);
  await assertPreExposureRecoveryBoundary({ ...boundary, journalPath: intent.journalPath,
    transactionId: journal.transactionId, phase: journal.phase, unitDirectory,
    inspectWriterGuards, managedWriterView: false });
  if (JSON.stringify(await readOriginalUnitViewRecord(unitRecordPath)) !== JSON.stringify(restored)) {
    throw new Error("Original unit view record changed during verification");
  }
  return { intent, journal, restored };
}

export async function verifyOriginalUnitViewRestored({ planPath, stopRecordPath, unitRecordPath,
  stateDatabase, unitDirectory = "/etc/systemd/system",
  inspectWriterGuards = inspectInstalledWriterGuards, ...boundary } = {}) {
  const proof = { ...boundary, planPath, stopRecordPath, unitRecordPath, stateDatabase,
    unitDirectory, inspectWriterGuards };
  const { intent, journal } = await verifyOriginalUnitViewBoundary(proof);
  const pair = await verifyStagedRecoveryPair({ ...boundary, journalPath: intent.journalPath,
    outputDir: intent.stagedDirectory, unitDirectory, inspectWriterGuards,
    managedWriterView: false });
  if (JSON.stringify(pair.destinations) !== JSON.stringify(intent.destinations)) {
    throw new Error("Live recovery destinations changed since rollback intent");
  }
  await verifyOriginalUnitViewBoundary(proof);
  return { transactionId: journal.transactionId, destinations: pair.destinations,
    stagedDirectory: intent.stagedDirectory, unitRecordPath };
}

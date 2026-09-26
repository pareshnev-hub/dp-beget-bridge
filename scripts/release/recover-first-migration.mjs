import path from "node:path";
import { deactivateCandidatePointer, readCandidatePointerRollbackRecord } from "./deactivate-candidate-pointer.mjs";
import { inspectMigrationRecovery } from "./inspect-migration-recovery.mjs";
import { prepareLiveReplacementLedger, readLiveReplacementLedger,
  replaceLiveStateFromLedger } from "./live-state-replacement-ledger.mjs";
import { readMigrationJournal } from "./migration-journal.mjs";
import { preparePreExposureRollback, readPreparedRollbackIntent } from "./prepare-pre-exposure-rollback.mjs";
import { readLegacyIngressRecord, reopenLegacyIngress } from "./reopen-legacy-ingress.mjs";
import { restartLegacyAfterRollback, readLegacyRestartRecord } from "./restart-legacy-after-rollback.mjs";
import { restoreOriginalUnitView, readOriginalUnitViewRecord } from "./restore-original-unit-view.mjs";
import { stageCompletePreExposureRecovery } from "./stage-complete-pre-exposure-recovery.mjs";
import { stageLiveStateRecovery, readLiveStateCopyRecord } from "./stage-live-state-recovery.mjs";
import { stopCandidateForRollback, readCandidateRollbackStopRecord } from "./stop-candidate-for-rollback.mjs";
import { DEFAULT_ADMISSION_PAUSE_PATH } from "../../packages/core/src/admission-gate.js";

const SESSION_DATABASE = "/var/lib/dp-beget-bridge/state.sqlite";
function absolute(filename) {
  return typeof filename === "string" && path.isAbsolute(filename) &&
    path.normalize(filename) === filename && filename !== "/";
}

// One attempt only, from a locally healthy candidate that has never opened
// ingress. Each called phase persists its own intent before touching live
// units or data. An interrupted attempt needs inspection of its phase records;
// this entry point never guesses whether a partially applied step can resume.
export async function recoverFirstMigration({ journalPath, marker, permit,
  unitDirectory = "/etc/systemd/system", releaseRoot, versionDir,
  admissionFlag = DEFAULT_ADMISSION_PAUSE_PATH,
  recoveryRoot, planPath, stopRecordPath, unitRecordPath, copyRecordPath,
  ledgerPath, pointerRecordPath, restartRecordPath, ingressRecordPath,
  assertRouteExclusive,
  inspectRecovery = inspectMigrationRecovery,
  stage = stageCompletePreExposureRecovery,
  prepare = preparePreExposureRollback,
  stopCandidate = stopCandidateForRollback,
  restoreUnits = restoreOriginalUnitView,
  stageCopies = stageLiveStateRecovery,
  prepareLedger = prepareLiveReplacementLedger,
  replaceState = replaceLiveStateFromLedger,
  deactivate = deactivateCandidatePointer,
  restartLegacy = restartLegacyAfterRollback,
  reopenIngress = reopenLegacyIngress,
  readIntent = readPreparedRollbackIntent,
  readStop = readCandidateRollbackStopRecord,
  readUnits = readOriginalUnitViewRecord,
  readCopies = readLiveStateCopyRecord,
  readLedger = readLiveReplacementLedger,
  readPointer = readCandidatePointerRollbackRecord,
  readRestart = readLegacyRestartRecord,
  readIngress = readLegacyIngressRecord } = {}) {
  const records = [recoveryRoot, planPath, stopRecordPath, unitRecordPath,
    copyRecordPath, ledgerPath, pointerRecordPath, restartRecordPath, ingressRecordPath];
  if (process.getuid?.() !== 0 || typeof assertRouteExclusive !== "function" ||
      ![journalPath, unitDirectory, releaseRoot, admissionFlag, ...records].every(absolute) ||
      new Set(records).size !== records.length) {
    throw new Error("Root, separate absolute recovery records and independent route proof are required");
  }
  const journal = await readMigrationJournal(journalPath);
  if (journal.phase !== "locally-healthy" ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?-[0-9a-f]{40}$/.test(versionDir || "") ||
      !versionDir.endsWith(`-${journal.newCommit}`)) {
    throw new Error("Only an unexposed, locally healthy first migration may rewind state");
  }
  const status = await inspectRecovery({ journalPath, marker });
  if (status.state !== "incomplete-transaction" || status.phase !== "locally-healthy") {
    throw new Error("Migration recovery has an unresolved marker or journal transition");
  }
  const boundary = { journalPath, marker, permit, unitDirectory, admissionFlag, assertRouteExclusive };
  const stateDatabase = SESSION_DATABASE;
  const sameTransaction = record => {
    if (record?.migrationTransactionId !== journal.transactionId) {
      throw new Error("Recovery step belongs to another migration");
    }
  };
  const staged = await stage({ ...boundary, outputDir: recoveryRoot });
  if (staged?.transactionId !== journal.transactionId || staged.phase !== "locally-healthy" ||
      staged.directory !== recoveryRoot) throw new Error("Staged recovery does not match the migration");
  await prepare({ ...boundary, stagedDirectory: recoveryRoot, planPath });
  const intent = await readIntent(planPath);
  sameTransaction(intent);
  if (intent.phase !== "prepared" || intent.journalPath !== journalPath ||
      intent.stagedDirectory !== recoveryRoot) throw new Error("Rollback intent differs from staged recovery");
  await stopCandidate({ ...boundary, planPath, stopRecordPath, stateDatabase });
  const stopped = await readStop(stopRecordPath);
  sameTransaction(stopped);
  if (stopped.phase !== "stopped" || stopped.planPath !== planPath) {
    throw new Error("Candidate stop was not journaled");
  }
  await restoreUnits({ ...boundary, planPath, stopRecordPath, unitRecordPath,
    stateDatabase, releaseRoot });
  const units = await readUnits(unitRecordPath);
  sameTransaction(units);
  if (units.phase !== "restored") throw new Error("Original unit view was not restored");
  await stageCopies({ ...boundary, recordPath: copyRecordPath, planPath, stopRecordPath,
    unitRecordPath, stateDatabase });
  const copies = await readCopies(copyRecordPath);
  sameTransaction(copies);
  if (copies.phase !== "prepared" || copies.planPath !== planPath ||
      copies.stopRecordPath !== stopRecordPath || copies.unitRecordPath !== unitRecordPath) {
    throw new Error("Live recovery copies were not prepared");
  }
  await prepareLedger({ ...boundary, ledgerPath, recordPath: copyRecordPath,
    planPath, stopRecordPath, unitRecordPath, stateDatabase });
  const ledger = await readLedger(ledgerPath);
  sameTransaction(ledger);
  if (ledger.phase !== "prepared" || ledger.copyRecordPath !== copyRecordPath) {
    throw new Error("Live state replacement was not prepared");
  }
  await replaceState({ ...boundary, ledgerPath, stateDatabase });
  const replaced = await readLedger(ledgerPath);
  sameTransaction(replaced);
  if (replaced.phase !== "replaced") throw new Error("Old state replacement was not journaled");
  await deactivate({ ...boundary, recordPath: pointerRecordPath, ledgerPath,
    stateDatabase, releaseRoot, versionDir });
  const pointer = await readPointer(pointerRecordPath);
  sameTransaction(pointer);
  if (pointer.phase !== "removed" || pointer.ledgerPath !== ledgerPath ||
      pointer.releaseRoot !== releaseRoot) throw new Error("Candidate pointer was not removed");
  await restartLegacy({ ...boundary, recordPath: restartRecordPath, pointerRecordPath,
    ledgerPath, stateDatabase, releaseRoot });
  const restart = await readRestart(restartRecordPath);
  sameTransaction(restart);
  if (restart.phase !== "started" || restart.pointerRecordPath !== pointerRecordPath) {
    throw new Error("Legacy services were not journaled healthy");
  }
  await reopenIngress({ ...boundary, recordPath: ingressRecordPath, restartRecordPath });
  const ingress = await readIngress(ingressRecordPath);
  sameTransaction(ingress);
  if (ingress.phase !== "exposed" || ingress.restartRecordPath !== restartRecordPath ||
      (await readMigrationJournal(journalPath)).phase !== "ingress-open") {
    throw new Error("Public legacy recovery was not journaled as possible exposure");
  }
  return { transactionId: journal.transactionId, phase: "ingress-open", legacyIngress: "exposed" };
}

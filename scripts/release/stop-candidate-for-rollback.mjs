import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertSessionHostRestartSafe } from "../deploy/session-host-restart-preflight.mjs";
import { verifyAdmissionPause } from "./admission-pause.mjs";
import { readMigrationJournal } from "./migration-journal.mjs";
import { verifyPreparedRollbackIntent } from "./prepare-pre-exposure-rollback.mjs";
import { readRegularFile } from "./verify-artifact.mjs";
import { localReleaseHealthProbes, waitForAdmissionDrain } from "./wait-admission-drain.mjs";
import { DEFAULT_ADMISSION_PAUSE_PATH } from "../../packages/core/src/admission-gate.js";

const exec = promisify(execFile);
const STOP_ORDER = ["dp-beget-mcp-oauth-spike.service", "dp-beget-mcp.service",
  "dp-beget-agent.service", "dp-beget-session-host.service"];
const FORMAT = "dp-beget-bridge-candidate-rollback-stop-v1";

async function systemctlShow(unit, property) {
  const { stdout } = await exec("systemctl", ["show", unit, `--property=${property}`, "--no-pager"],
    { timeout: 5000, maxBuffer: 4096 });
  const match = /^([A-Za-z]+)=([a-z-]+)\n$/.exec(stdout);
  if (!match || match[1] !== property) throw new Error(`Invalid candidate ${property}: ${unit}`);
  return match[2];
}
async function systemctlStop(unit) {
  await exec("systemctl", ["stop", unit], { timeout: 20000, maxBuffer: 4096 });
}
async function assertPausedAndDrained() {
  return waitForAdmissionDrain({ probes: localReleaseHealthProbes({ oauthPort: 8789 }), timeoutMs: 15000 });
}
async function trustedParent(filename) {
  if (!path.isAbsolute(filename || "") || path.normalize(filename) !== filename) {
    throw new Error("Candidate stop record path must be normalized and absolute");
  }
  const parent = path.dirname(filename);
  const info = await lstat(parent);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
      (await realpath(parent)) !== parent) throw new Error("Untrusted candidate stop record parent");
  return parent;
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
function validate(record) {
  if (!record || Object.keys(record).sort().join(",") !==
        "format,intentSha256,migrationTransactionId,phase,planPath,stoppedUnits" ||
      record.format !== FORMAT || !["stopping", "stopped"].includes(record.phase) ||
      !/^[0-9a-f-]{36}$/.test(record.migrationTransactionId || "") ||
      !/^[0-9a-f]{64}$/.test(record.intentSha256 || "") ||
      !path.isAbsolute(record.planPath || "") || path.normalize(record.planPath) !== record.planPath ||
      !Array.isArray(record.stoppedUnits) ||
      JSON.stringify(record.stoppedUnits) !== JSON.stringify(record.phase === "stopped" ? STOP_ORDER : [])) {
    throw new Error("Invalid candidate rollback stop record");
  }
  return record;
}
export async function readCandidateRollbackStopRecord(filename) {
  await trustedParent(filename);
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o077) !== 0 ||
      info.size > 4096 || (await realpath(filename)) !== filename) {
    throw new Error("Untrusted candidate rollback stop record");
  }
  return validate(JSON.parse((await readRegularFile(filename, 4096)).toString("utf8")));
}

export async function verifyCandidateRollbackStopped({ planPath, stopRecordPath, stateDatabase,
  admissionFlag = DEFAULT_ADMISSION_PAUSE_PATH, verifyPaused = verifyAdmissionPause,
  assertLedgerSafe = assertSessionHostRestartSafe, getIngressState,
  getState = unit => systemctlShow(unit, "ActiveState"), ...boundary } = {}) {
  if (process.getuid?.() !== 0 || !path.isAbsolute(stateDatabase || "") ||
      path.normalize(stateDatabase) !== stateDatabase || !path.isAbsolute(admissionFlag || "") ||
      path.normalize(admissionFlag) !== admissionFlag) {
    throw new Error("Root and absolute state database are required to verify stopped writers");
  }
  const record = await readCandidateRollbackStopRecord(stopRecordPath);
  if (record.phase !== "stopped" || record.planPath !== planPath ||
      createHash("sha256").update(await readRegularFile(planPath, 16 * 1024)).digest("hex") !==
        record.intentSha256) throw new Error("Candidate stop intent is incomplete or changed");
  const proofBoundary = { ...boundary, ...(getIngressState ? { getState: getIngressState } : {}) };
  const intent = await verifyPreparedRollbackIntent({ ...proofBoundary, planPath });
  if (intent.migrationTransactionId !== record.migrationTransactionId) {
    throw new Error("Candidate stop belongs to another migration");
  }
  await verifyPaused({ flag: admissionFlag });
  for (const unit of STOP_ORDER) {
    if (await getState(unit) !== "inactive") throw new Error(`Candidate writer restarted: ${unit}`);
  }
  await assertLedgerSafe(stateDatabase);
  return record;
}

// A missing or 'stopping' record must never be interpreted as permission to
// restore live state. Only a verified 'stopped' record can be considered by
// a later per-file replacement controller.
export async function stopCandidateForRollback({ planPath, stopRecordPath, stateDatabase,
  admissionFlag = DEFAULT_ADMISSION_PAUSE_PATH, assertPaused = assertPausedAndDrained,
  verifyPaused = verifyAdmissionPause, assertLedgerSafe = assertSessionHostRestartSafe,
  getIngressState,
  getState = unit => systemctlShow(unit, "ActiveState"),
  getKillMode = unit => systemctlShow(unit, "KillMode"), stopUnit = systemctlStop,
  ...boundary } = {}) {
  if (process.getuid?.() !== 0 || !path.isAbsolute(stateDatabase || "") ||
      path.normalize(stateDatabase) !== stateDatabase || !path.isAbsolute(admissionFlag || "") ||
      path.normalize(admissionFlag) !== admissionFlag) {
    throw new Error("Root, absolute state database and admission pause are required");
  }
  const parent = await trustedParent(stopRecordPath);
  const proofBoundary = { ...boundary, ...(getIngressState ? { getState: getIngressState } : {}) };
  const intent = await verifyPreparedRollbackIntent({ ...proofBoundary, planPath });
  if (intent.migrationPhase !== "locally-healthy" ||
      stopRecordPath === planPath || stopRecordPath === intent.stagedDirectory ||
      stopRecordPath.startsWith(`${intent.stagedDirectory}${path.sep}`)) {
    throw new Error("Only a locally healthy candidate with separate stop record can be stopped");
  }
  const journal = await readMigrationJournal(intent.journalPath);
  if ([journal.snapshotPath, journal.unitBackup.path].some(directory =>
    stopRecordPath === directory || stopRecordPath.startsWith(`${directory}${path.sep}`))) {
    throw new Error("Candidate stop record must be outside both migration backups");
  }
  await verifyPaused({ flag: admissionFlag });
  await assertPaused();
  if (await getKillMode("dp-beget-session-host.service") !== "process") {
    throw new Error("Session Host stop could terminate retained tmux processes");
  }
  for (const unit of STOP_ORDER) {
    if (await getState(unit) !== "active") throw new Error(`Candidate service is not active: ${unit}`);
  }
  const intentSha256 = createHash("sha256").update(await readRegularFile(planPath, 16 * 1024)).digest("hex");
  const record = validate({ format: FORMAT, intentSha256,
    migrationTransactionId: intent.migrationTransactionId, planPath,
    phase: "stopping", stoppedUnits: [] });
  const handle = await open(stopRecordPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(parent);
  for (const unit of STOP_ORDER) {
    if (unit === "dp-beget-session-host.service") await assertLedgerSafe(stateDatabase);
    await stopUnit(unit);
    if (await getState(unit) !== "inactive") throw new Error(`Candidate writer remains active: ${unit}`);
  }
  await verifyPreparedRollbackIntent({ ...proofBoundary, planPath });
  await verifyPaused({ flag: admissionFlag });
  const next = validate({ ...record, phase: "stopped", stoppedUnits: [...STOP_ORDER] });
  const temporary = `${stopRecordPath}.${randomUUID()}.tmp`;
  const updated = await open(temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await updated.writeFile(JSON.stringify(next) + "\n"); await updated.sync(); }
  finally { await updated.close(); }
  await rename(temporary, stopRecordPath);
  await syncDirectory(parent);
  return verifyCandidateRollbackStopped({ ...proofBoundary, planPath, stopRecordPath, stateDatabase,
    admissionFlag, verifyPaused, assertLedgerSafe, getIngressState, getState });
}

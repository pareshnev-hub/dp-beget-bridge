import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readCandidatePointerRollbackRecord } from "./deactivate-candidate-pointer.mjs";
import { assertOriginalAppUnits } from "./install-managed-overrides.mjs";
import { inspectLiveReplacementLedger, readLiveReplacementLedger } from "./live-state-replacement-ledger.mjs";
import { readMigrationJournal, verifyJournalUnitBackup } from "./migration-journal.mjs";
import { readPreparedRollbackIntent } from "./prepare-pre-exposure-rollback.mjs";
import { probeLegacyLocalHealth } from "./probe-legacy-health.mjs";
import { readOriginalUnitViewRecord } from "./restore-original-unit-view.mjs";
import { readLiveStateCopyRecord } from "./stage-live-state-recovery.mjs";
import { assertPreExposureRecoveryBoundary } from "./stage-pre-exposure-recovery.mjs";
import { verifyJournalStateBundle } from "./snapshot-legacy-state.mjs";
import { readRegularFile } from "./verify-artifact.mjs";
import { WRITER_START_PERMIT } from "./writer-boot-guard.mjs";
import { assertWriterPermitAbsent, withWriterStartPermit } from "./writer-start-permit.mjs";
import { PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";

const exec = promisify(execFile);
const FORMAT = "dp-beget-bridge-first-migration-legacy-restart-v1";
const START = ["dp-beget-session-host.service", "dp-beget-agent.service",
  "dp-beget-mcp.service", "dp-beget-mcp-oauth-spike.service"];
const PRODUCTS = ["DP Beget Bridge", "DP Beget Bridge", "DP Beget Bridge",
  "DP Beget Bridge Session Host"];
function absolute(filename) {
  return typeof filename === "string" && path.isAbsolute(filename) && path.normalize(filename) === filename;
}
async function systemctlState(unit) {
  const { stdout } = await exec("systemctl", ["show", unit, "--property=ActiveState", "--no-pager"],
    { timeout: 5000, maxBuffer: 4096 });
  if (!/^ActiveState=[a-z-]+\n$/.test(stdout)) throw new Error(`Invalid legacy unit state: ${unit}`);
  return stdout.trim().slice("ActiveState=".length);
}
async function startSystemd(unit) {
  await exec("systemctl", ["start", unit], { timeout: 20000, maxBuffer: 4096 });
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function trustedParent(filename) {
  if (!absolute(filename)) throw new Error("Legacy restart requires an absolute record path");
  const parent = path.dirname(filename);
  const info = await lstat(parent);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
      (await realpath(parent)) !== parent) throw new Error("Untrusted legacy restart record parent");
  return parent;
}
function validate(record) {
  if (!record || Object.keys(record).sort().join(",") !==
        "format,ledgerPath,ledgerSha256,migrationTransactionId,phase,pointerRecordPath,pointerRecordSha256" ||
      record.format !== FORMAT || !["starting", "started"].includes(record.phase) ||
      ![record.ledgerPath, record.pointerRecordPath].every(absolute) ||
      ![record.ledgerSha256, record.pointerRecordSha256].every(value => /^[0-9a-f]{64}$/.test(value || "")) ||
      !/^[0-9a-f-]{36}$/.test(record.migrationTransactionId || "")) {
    throw new Error("Invalid legacy restart record");
  }
  return record;
}
export async function readLegacyRestartRecord(recordPath) {
  await trustedParent(recordPath);
  const info = await lstat(recordPath);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o077) !== 0 ||
      info.size > 4096 || (await realpath(recordPath)) !== recordPath) {
    throw new Error("Untrusted legacy restart record");
  }
  return validate(JSON.parse((await readRegularFile(recordPath, 4096)).toString("utf8")));
}
async function boundary({ pointerRecordPath, ledgerPath, releaseRoot, marker, permit,
  unitDirectory, stateDatabase, getState, ...proof }) {
  const pointer = await readCandidatePointerRollbackRecord(pointerRecordPath);
  const ledger = await readLiveReplacementLedger(ledgerPath);
  if (ledger.phase !== "replaced") throw new Error("Old state replacement is not completed");
  const copies = await readLiveStateCopyRecord(ledger.copyRecordPath);
  const intent = await readPreparedRollbackIntent(copies.planPath);
  const journal = await readMigrationJournal(intent.journalPath);
  const original = await readOriginalUnitViewRecord(copies.unitRecordPath);
  if (pointer.phase !== "removed" || pointer.ledgerPath !== ledgerPath ||
      pointer.releaseRoot !== releaseRoot ||
      pointer.ledgerSha256 !== createHash("sha256").update(await readRegularFile(ledgerPath, 64 * 1024)).digest("hex") ||
      pointer.migrationTransactionId !== journal.transactionId ||
      original.phase !== "restored" || original.migrationTransactionId !== journal.transactionId ||
      journal.phase !== "locally-healthy") {
    throw new Error("Legacy restart is not bound to completed pre-exposure recovery");
  }
  await verifyJournalUnitBackup(journal);
  await verifyJournalStateBundle(journal);
  await assertOriginalAppUnits(journal, unitDirectory);
  for (const name of ["current", "previous", ".activation.lock"]) {
    try { await lstat(path.join(releaseRoot, name)); throw new Error(`Unexpected release pointer: ${name}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await assertPreExposureRecoveryBoundary({ ...proof, journalPath: intent.journalPath,
    transactionId: journal.transactionId, phase: journal.phase,
    marker, permit, unitDirectory, getState, managedWriterView: false });
  await assertWriterPermitAbsent(permit);
  return { pointer, journal, intent, ledger };
}
function assertRecordPlacement(recordPath, { journal, intent, ledger }, unitDirectory, releaseRoot) {
  const protectedRoots = [releaseRoot, unitDirectory, intent.stagedDirectory,
    journal.snapshotPath, journal.unitBackup.path,
    ...ledger.targets.filter(item => item.kind === "config").flatMap(item => [item.live, item.parked])];
  if (protectedRoots.some(directory => recordPath === directory ||
      recordPath.startsWith(`${directory}${path.sep}`)) ||
      ledger.targets.some(item => [item.live, item.copy, item.parked].includes(recordPath))) {
    throw new Error("Legacy restart record must be outside live state, units and backups");
  }
}
export function assertLegacyHealthResult(result) {
  if (result?.services !== 4 || JSON.stringify(result.products) !== JSON.stringify(PRODUCTS)) {
    throw new Error("Four exact R0003 local health responses are required");
  }
}

// R0003 ignores the R0004 admission pause. The persistent marker keeps the
// dedicated public ingress closed while the scoped /run permit allows only
// these original units to start. 'starting' survives partial startup.
export async function restartLegacyAfterRollback({ recordPath, pointerRecordPath, ledgerPath,
  stateDatabase, releaseRoot, marker = PERSISTENT_MARKER, permit = WRITER_START_PERMIT,
  unitDirectory = "/etc/systemd/system", getState = systemctlState,
  startUnit = startSystemd, withPermit = withWriterStartPermit,
  assertLegacyHealthy = probeLegacyLocalHealth, ...proof } = {}) {
  if (process.getuid?.() !== 0 || ![recordPath, pointerRecordPath, ledgerPath,
    stateDatabase, releaseRoot, marker, permit, unitDirectory].every(absolute) ||
      new Set([recordPath, pointerRecordPath, ledgerPath]).size !== 3 ||
      typeof proof.assertRouteExclusive !== "function") {
    throw new Error("Root, recovery records and exclusive route proof are required");
  }
  const parent = await trustedParent(recordPath);
  let record;
  try { record = await readLegacyRestartRecord(recordPath); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const initial = await inspectLiveReplacementLedger({ ...proof, ledgerPath, stateDatabase,
      unitDirectory, marker, permit, getState });
    if (initial.record.phase !== "replaced" ||
        initial.positions.some(position => position !== "installed")) {
      throw new Error("Old state is not fully restored before legacy startup");
    }
    for (const unit of START) {
      if (await getState(unit) !== "inactive") throw new Error(`Legacy writer was already active: ${unit}`);
    }
    const initialBoundary = await boundary({ ...proof, pointerRecordPath, ledgerPath, releaseRoot,
      marker, permit, unitDirectory, stateDatabase, getState });
    assertRecordPlacement(recordPath, initialBoundary, unitDirectory, releaseRoot);
    const { journal } = initialBoundary;
    record = validate({ format: FORMAT, phase: "starting", ledgerPath, pointerRecordPath,
      migrationTransactionId: journal.transactionId,
      ledgerSha256: createHash("sha256").update(await readRegularFile(ledgerPath, 64 * 1024)).digest("hex"),
      pointerRecordSha256: createHash("sha256").update(await readRegularFile(pointerRecordPath, 4096)).digest("hex") });
    const handle = await open(recordPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    await syncDirectory(parent);
  }
  const checked = await boundary({ ...proof, pointerRecordPath, ledgerPath, releaseRoot,
    marker, permit, unitDirectory, stateDatabase, getState });
  assertRecordPlacement(recordPath, checked, unitDirectory, releaseRoot);
  const { journal } = checked;
  if (record.ledgerPath !== ledgerPath || record.pointerRecordPath !== pointerRecordPath ||
      record.migrationTransactionId !== journal.transactionId ||
      record.ledgerSha256 !== createHash("sha256").update(await readRegularFile(ledgerPath, 64 * 1024)).digest("hex") ||
      record.pointerRecordSha256 !== createHash("sha256").update(await readRegularFile(pointerRecordPath, 4096)).digest("hex")) {
    throw new Error("Legacy restart record changed or belongs to another recovery");
  }
  let activePrefix = 0;
  for (const unit of START) {
    const state = await getState(unit);
    if (state === "active" && activePrefix === START.indexOf(unit)) activePrefix++;
    else if (state !== "inactive") throw new Error(`Unexpected legacy writer state: ${unit}`);
  }
  if (record.phase === "starting" && activePrefix < START.length) {
    await withPermit({ marker, permit, action: async () => {
      for (const unit of START.slice(activePrefix)) {
        await startUnit(unit);
        if (await getState(unit) !== "active") throw new Error(`Legacy writer failed to start: ${unit}`);
      }
    } });
  }
  await boundary({ ...proof, pointerRecordPath, ledgerPath, releaseRoot,
    marker, permit, unitDirectory, stateDatabase, getState });
  for (const unit of START) {
    if (await getState(unit) !== "active") throw new Error(`Legacy writer is not active: ${unit}`);
  }
  assertLegacyHealthResult(await assertLegacyHealthy());
  if (record.phase === "starting") {
    const current = await readLegacyRestartRecord(recordPath);
    if (JSON.stringify(current) !== JSON.stringify(record)) throw new Error("Legacy restart record changed");
    const next = validate({ ...record, phase: "started" });
    const temporary = `${recordPath}.${randomUUID()}.tmp`;
    const handle = await open(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(next) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, recordPath);
    await syncDirectory(parent);
    record = next;
  }
  await boundary({ ...proof, pointerRecordPath, ledgerPath, releaseRoot,
    marker, permit, unitDirectory, stateDatabase, getState });
  return record;
}

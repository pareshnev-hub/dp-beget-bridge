import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";
import { inspectInstalledWriterGuards } from "./installed-writer-guard-preflight.mjs";
import { inspectInstalledManagedUnits } from "./installed-managed-unit-preflight.mjs";
import { assertOriginalAppUnits } from "./install-managed-overrides.mjs";
import { readMigrationJournal, verifyJournalUnitBackup } from "./migration-journal.mjs";
import { readPreparedRollbackIntent } from "./prepare-pre-exposure-rollback.mjs";
import { verifyMarker } from "./quiesce-legacy-writers.mjs";
import { MANAGED_APP_UNITS, MANAGED_DROP_IN, managedUnitContent } from "./stage-managed-unit-overrides.mjs";
import { verifyCandidateRollbackStopped } from "./stop-candidate-for-rollback.mjs";
import { readRegularFile } from "./verify-artifact.mjs";
import { WRITER_GUARD_DROP_IN, WRITER_START_PERMIT } from "./writer-boot-guard.mjs";
import { assertWriterPermitAbsent } from "./writer-start-permit.mjs";

const exec = promisify(execFile);
const FORMAT = "dp-beget-bridge-original-unit-view-v1";
const INGRESS = ["dp-beget-oauth-proxy.socket", "dp-beget-oauth-proxy.service", "dp-beget-tunnel.service"];
async function daemonReload() { await exec("systemctl", ["daemon-reload"], { timeout: 20000, maxBuffer: 4096 }); }
async function systemctlState(unit) {
  const { stdout } = await exec("systemctl", ["show", unit, "--property=ActiveState", "--no-pager"],
    { timeout: 5000, maxBuffer: 4096 });
  if (!/^ActiveState=[a-z-]+\n$/.test(stdout)) throw new Error(`Invalid ingress state: ${unit}`);
  return stdout.trim().slice("ActiveState=".length);
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function trustedDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
      (await realpath(directory)) !== directory) throw new Error("Untrusted rollback unit directory");
}
function validRecord(record) {
  if (!record || Object.keys(record).sort().join(",") !==
        "format,migrationTransactionId,phase,stopRecordSha256,unitManifestSha256,units" ||
      record.format !== FORMAT || !["restoring", "restored"].includes(record.phase) ||
      !/^[0-9a-f-]{36}$/.test(record.migrationTransactionId || "") ||
      !/^[0-9a-f]{64}$/.test(record.stopRecordSha256 || "") ||
      !/^[0-9a-f]{64}$/.test(record.unitManifestSha256 || "") ||
      JSON.stringify(record.units) !== JSON.stringify(record.phase === "restored" ? MANAGED_APP_UNITS : [])) {
    throw new Error("Invalid original unit view recovery record");
  }
  return record;
}
export async function readOriginalUnitViewRecord(filename) {
  const parent = path.dirname(filename);
  await trustedDirectory(parent);
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o077) !== 0 ||
      info.size > 4096 || (await realpath(filename)) !== filename) {
    throw new Error("Untrusted original unit view recovery record");
  }
  return validRecord(JSON.parse((await readRegularFile(filename, 4096)).toString("utf8")));
}

// Removes only the four R0004 managed bindings after candidate writers are
// durably stopped. The original fragments, compatibility drop-in and both
// sets of reboot guards stay installed while the marker closes ingress.
export async function restoreOriginalUnitView({ planPath, stopRecordPath, unitRecordPath,
  stateDatabase, unitDirectory = "/etc/systemd/system", releaseRoot,
  marker = PERSISTENT_MARKER, permit = WRITER_START_PERMIT,
  inspectManaged = inspectInstalledManagedUnits, inspectWriterGuards = inspectInstalledWriterGuards,
  getIngressState = systemctlState, getWriterState = systemctlState, reload = daemonReload,
  ...proof } = {}) {
  if (process.getuid?.() !== 0 || !path.isAbsolute(unitRecordPath || "") ||
      path.normalize(unitRecordPath) !== unitRecordPath || !path.isAbsolute(unitDirectory || "") ||
      typeof proof.assertRouteExclusive !== "function") {
    throw new Error("Root, separate unit record and recovery route proof are required");
  }
  const parent = path.dirname(unitRecordPath);
  await trustedDirectory(parent);
  await trustedDirectory(unitDirectory);
  if (unitRecordPath === planPath || unitRecordPath === stopRecordPath ||
      unitRecordPath.startsWith(`${unitDirectory}${path.sep}`)) {
    throw new Error("Unit recovery record must be separate from live units and earlier intents");
  }
  const stopped = await verifyCandidateRollbackStopped({ ...proof, planPath, stopRecordPath,
    stateDatabase, getIngressState, marker, permit, inspectWriterGuards, unitDirectory });
  const intent = await readPreparedRollbackIntent(planPath);
  const journal = await readMigrationJournal(intent.journalPath);
  if (journal.transactionId !== stopped.migrationTransactionId) throw new Error("Migration changed before unit restore");
  if ([journal.snapshotPath, journal.unitBackup.path, intent.stagedDirectory].some(directory =>
    unitRecordPath === directory || unitRecordPath.startsWith(`${directory}${path.sep}`))) {
    throw new Error("Unit recovery record must be outside backups and staged recovery");
  }
  await verifyJournalUnitBackup(journal);
  await assertOriginalAppUnits(journal, unitDirectory);
  await inspectManaged({ unitDirectory, releaseRoot, marker, permit });
  await verifyMarker(marker);
  await assertWriterPermitAbsent(permit);
  const expected = managedUnitContent(releaseRoot);
  for (const unit of MANAGED_APP_UNITS) {
    const directory = path.join(unitDirectory, `${unit}.d`);
    await trustedDirectory(directory);
    const entries = (await readdir(directory)).sort();
    const allowed = unit === "dp-beget-mcp-oauth-spike.service"
      ? ["10-dp012-dcr.conf", WRITER_GUARD_DROP_IN, MANAGED_DROP_IN].sort()
      : [WRITER_GUARD_DROP_IN, MANAGED_DROP_IN].sort();
    if (JSON.stringify(entries) !== JSON.stringify(allowed)) throw new Error(`Unexpected drop-in inventory: ${unit}`);
    const filename = path.join(directory, MANAGED_DROP_IN);
    const info = await lstat(filename);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
        (await realpath(filename)) !== filename ||
        (await readRegularFile(filename, 4096)).toString("utf8") !== expected) {
      throw new Error(`Untrusted managed binding: ${unit}`);
    }
  }
  const stopRecordSha256 = createHash("sha256").update(await readRegularFile(stopRecordPath, 4096)).digest("hex");
  const record = validRecord({ format: FORMAT, phase: "restoring", units: [],
    migrationTransactionId: journal.transactionId, stopRecordSha256,
    unitManifestSha256: journal.unitBackup.manifestSha256 });
  const handle = await open(unitRecordPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(parent);
  for (const unit of MANAGED_APP_UNITS) {
    const directory = path.join(unitDirectory, `${unit}.d`);
    await unlink(path.join(directory, MANAGED_DROP_IN));
    await syncDirectory(directory);
  }
  await syncDirectory(unitDirectory);
  await reload();
  await inspectWriterGuards({ unitDirectory, marker, permit, managed: false });
  await assertOriginalAppUnits(journal, unitDirectory);
  await verifyMarker(marker);
  await assertWriterPermitAbsent(permit);
  for (const unit of MANAGED_APP_UNITS) {
    if (await getWriterState(unit) !== "inactive") throw new Error(`Writer restarted during unit recovery: ${unit}`);
  }
  for (const unit of INGRESS) {
    if (await getIngressState(unit) !== "inactive") throw new Error(`Ingress restarted: ${unit}`);
  }
  if (await proof.assertRouteExclusive() !== true) throw new Error("Public route changed during unit recovery");
  const next = validRecord({ ...record, phase: "restored", units: [...MANAGED_APP_UNITS] });
  const temporary = `${unitRecordPath}.${randomUUID()}.tmp`;
  const updated = await open(temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await updated.writeFile(JSON.stringify(next) + "\n"); await updated.sync(); }
  finally { await updated.close(); }
  await rename(temporary, unitRecordPath);
  await syncDirectory(parent);
  return readOriginalUnitViewRecord(unitRecordPath);
}

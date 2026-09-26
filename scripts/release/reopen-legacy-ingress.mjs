import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createPersistentMarker, removePersistentMarker } from "./close-legacy-ingress.mjs";
import { readCandidatePointerRollbackRecord } from "./deactivate-candidate-pointer.mjs";
import { PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";
import { inspectInstalledIngressGuard } from "./installed-ingress-guard-preflight.mjs";
import { inspectInstalledWriterGuards } from "./installed-writer-guard-preflight.mjs";
import { assertOriginalAppUnits } from "./install-managed-overrides.mjs";
import { readLiveReplacementLedger } from "./live-state-replacement-ledger.mjs";
import { advanceMigrationJournal, readMigrationJournal, verifyJournalUnitBackup } from "./migration-journal.mjs";
import { readPreparedRollbackIntent } from "./prepare-pre-exposure-rollback.mjs";
import { probeLegacyLocalHealth } from "./probe-legacy-health.mjs";
import { probePublicLegacyOAuth } from "./public-legacy-probe.mjs";
import { assertLegacyHealthResult, readLegacyRestartRecord } from "./restart-legacy-after-rollback.mjs";
import { readLiveStateCopyRecord } from "./stage-live-state-recovery.mjs";
import { verifyJournalStateBundle } from "./snapshot-legacy-state.mjs";
import { readRegularFile } from "./verify-artifact.mjs";
import { WRITER_START_PERMIT } from "./writer-boot-guard.mjs";
import { assertWriterPermitAbsent } from "./writer-start-permit.mjs";
import { verifyMarker } from "./quiesce-legacy-writers.mjs";

const exec = promisify(execFile);
const FORMAT = "dp-beget-bridge-first-migration-legacy-ingress-v1";
const INGRESS = ["dp-beget-oauth-proxy.socket", "dp-beget-oauth-proxy.service", "dp-beget-tunnel.service"];
const START = ["dp-beget-oauth-proxy.socket", "dp-beget-tunnel.service"];
const WRITERS = ["dp-beget-session-host.service", "dp-beget-agent.service",
  "dp-beget-mcp.service", "dp-beget-mcp-oauth-spike.service"];
export async function assertOriginalIngressUnits(journal, unitDirectory) {
  const manifest = JSON.parse((await readRegularFile(path.join(journal.unitBackup.path,
    "backup-manifest.json"), 64 * 1024)).toString("utf8"));
  const fragments = manifest.files.filter(item => INGRESS.includes(item.unit) && item.path === item.unit);
  if (fragments.length !== INGRESS.length) throw new Error("Original ingress fragments are missing from backup");
  for (const item of fragments) {
    const filename = path.join(unitDirectory, item.path);
    const info = await lstat(filename);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== item.uid || info.gid !== item.gid ||
        (info.mode & 0o777) !== item.mode || (await realpath(filename)) !== filename ||
        createHash("sha256").update(await readRegularFile(filename, 64 * 1024)).digest("hex") !== item.sha256) {
      throw new Error(`Original ingress fragment changed: ${item.unit}`);
    }
  }
}
function absolute(filename) {
  return typeof filename === "string" && path.isAbsolute(filename) && path.normalize(filename) === filename;
}
async function systemctlState(unit) {
  const { stdout } = await exec("systemctl", ["show", unit, "--property=ActiveState", "--no-pager"],
    { timeout: 5000, maxBuffer: 4096 });
  if (!/^ActiveState=[a-z-]+\n$/.test(stdout)) throw new Error(`Invalid legacy ingress state: ${unit}`);
  return stdout.trim().slice("ActiveState=".length);
}
async function systemctlStart(unit) {
  await exec("systemctl", ["start", unit], { timeout: 20000, maxBuffer: 4096 });
}
async function systemctlStop(unit) {
  await exec("systemctl", ["stop", unit], { timeout: 20000, maxBuffer: 4096 });
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function trustedParent(filename) {
  if (!absolute(filename)) throw new Error("Legacy ingress record requires an absolute path");
  const parent = path.dirname(filename);
  const info = await lstat(parent);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
      (await realpath(parent)) !== parent) throw new Error("Untrusted legacy ingress record parent");
  return parent;
}
async function absent(filename) {
  try { await lstat(filename); return false; }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
}
function validate(record) {
  if (!record || Object.keys(record).sort().join(",") !==
        "format,migrationTransactionId,phase,restartRecordPath,restartRecordSha256" ||
      record.format !== FORMAT || !["exposing", "exposed"].includes(record.phase) ||
      !absolute(record.restartRecordPath) ||
      !/^[0-9a-f]{64}$/.test(record.restartRecordSha256 || "") ||
      !/^[0-9a-f-]{36}$/.test(record.migrationTransactionId || "")) {
    throw new Error("Invalid legacy ingress release record");
  }
  return record;
}
export async function readLegacyIngressRecord(recordPath) {
  await trustedParent(recordPath);
  const info = await lstat(recordPath);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o077) !== 0 ||
      info.size > 4096 || (await realpath(recordPath)) !== recordPath) {
    throw new Error("Untrusted legacy ingress release record");
  }
  return validate(JSON.parse((await readRegularFile(recordPath, 4096)).toString("utf8")));
}
async function recoveryBindings(restartRecordPath, unitDirectory) {
  const restart = await readLegacyRestartRecord(restartRecordPath);
  const pointer = await readCandidatePointerRollbackRecord(restart.pointerRecordPath);
  const replacement = await readLiveReplacementLedger(restart.ledgerPath);
  const copies = await readLiveStateCopyRecord(replacement.copyRecordPath);
  const intent = await readPreparedRollbackIntent(copies.planPath);
  const journal = await readMigrationJournal(intent.journalPath);
  if (restart.phase !== "started" || pointer.phase !== "removed" ||
      replacement.phase !== "replaced" || restart.migrationTransactionId !== journal.transactionId ||
      pointer.migrationTransactionId !== journal.transactionId ||
      !["locally-healthy", "ingress-open"].includes(journal.phase) ||
      restart.ledgerPath !== pointer.ledgerPath ||
      restart.ledgerSha256 !== createHash("sha256").update(await readRegularFile(restart.ledgerPath, 64 * 1024)).digest("hex") ||
      restart.pointerRecordSha256 !== createHash("sha256").update(await readRegularFile(restart.pointerRecordPath, 4096)).digest("hex") ||
      pointer.ledgerSha256 !== restart.ledgerSha256) {
    throw new Error("Legacy recovery is incomplete before ingress release");
  }
  await verifyJournalUnitBackup(journal);
  await verifyJournalStateBundle(journal);
  await assertOriginalAppUnits(journal, unitDirectory);
  await assertOriginalIngressUnits(journal, unitDirectory);
  for (const name of ["current", "previous", ".activation.lock"]) {
    if (!(await absent(path.join(pointer.releaseRoot, name)))) {
      throw new Error(`Candidate release pointer reappeared: ${name}`);
    }
  }
  return { restart, pointer, journal, intent, replacement };
}
async function proof({ marker, permit, unitDirectory, assertRouteExclusive, inspectGuard,
  inspectWriterGuards, getState, assertLegacyHealthy }, markerExpected) {
  if (markerExpected) await verifyMarker(marker);
  else if (!(await absent(marker))) throw new Error("Legacy ingress marker remains active");
  await assertWriterPermitAbsent(permit);
  await inspectGuard({ unitDirectory, marker });
  await inspectWriterGuards({ unitDirectory, marker, permit, managed: false });
  for (const unit of WRITERS) {
    if (await getState(unit) !== "active") throw new Error(`Recovered R0003 writer is not active: ${unit}`);
  }
  assertLegacyHealthResult(await assertLegacyHealthy());
  if (await assertRouteExclusive() !== true) throw new Error("Exclusive legacy public route not proven");
}

// The exposing record is durable before the marker is removed. A failed
// release restores the marker and stops dedicated ingress. Because R0003
// could have handled public requests meanwhile, no old-state rewind follows.
export async function reopenLegacyIngress({ recordPath, restartRecordPath,
  marker = PERSISTENT_MARKER, permit = WRITER_START_PERMIT,
  unitDirectory = "/etc/systemd/system", assertRouteExclusive,
  assertPublicLegacy = probePublicLegacyOAuth, assertLegacyHealthy = probeLegacyLocalHealth,
  inspectGuard = inspectInstalledIngressGuard,
  inspectWriterGuards = inspectInstalledWriterGuards,
  getState = systemctlState, startUnit = systemctlStart, stopUnit = systemctlStop,
  removeMarker = removePersistentMarker, restoreMarker = createPersistentMarker } = {}) {
  if (process.getuid?.() !== 0 || ![recordPath, restartRecordPath, marker, permit,
    unitDirectory].every(absolute) || recordPath === restartRecordPath ||
      typeof assertRouteExclusive !== "function" || typeof assertPublicLegacy !== "function") {
    throw new Error("Root, recovery records, exclusive route and public legacy proof are required");
  }
  const parent = await trustedParent(recordPath);
  const bindings = await recoveryBindings(restartRecordPath, unitDirectory);
  if ([unitDirectory, bindings.pointer.releaseRoot, bindings.intent.stagedDirectory, bindings.journal.snapshotPath,
    bindings.journal.unitBackup.path, bindings.replacement.targets[0].live,
    bindings.replacement.targets[0].parked].some(directory =>
    recordPath === directory || recordPath.startsWith(`${directory}${path.sep}`)) ||
      bindings.replacement.targets.some(item => [item.live, item.copy, item.parked].includes(recordPath))) {
    throw new Error("Legacy ingress record must be outside live state, units and backups");
  }
  const expectedSha = createHash("sha256").update(await readRegularFile(restartRecordPath, 4096)).digest("hex");
  const boundary = { marker, permit, unitDirectory, assertRouteExclusive, inspectGuard,
    inspectWriterGuards, getState, assertLegacyHealthy };
  if (!(await absent(recordPath))) {
    const existing = await readLegacyIngressRecord(recordPath);
    if (existing.restartRecordPath !== restartRecordPath ||
        existing.restartRecordSha256 !== expectedSha ||
        existing.migrationTransactionId !== bindings.journal.transactionId) {
      throw new Error("Legacy ingress record belongs to another recovery");
    }
    if (existing.phase === "exposing") {
      throw new Error("Possible legacy public exposure requires manual inspection");
    }
    await proof(boundary, false);
    for (const unit of START) {
      if (await getState(unit) !== "active") throw new Error(`Legacy ingress is not active: ${unit}`);
    }
    if (await assertPublicLegacy() !== true) throw new Error("Public R0003 response not proven");
    return existing;
  }
  if (bindings.journal.phase !== "locally-healthy") {
    throw new Error("Possible public exposure requires manual inspection");
  }
  await proof(boundary, true);
  for (const unit of INGRESS) {
    if (await getState(unit) !== "inactive") throw new Error(`Legacy ingress already active: ${unit}`);
  }
  const record = validate({ format: FORMAT, phase: "exposing",
    restartRecordPath, restartRecordSha256: expectedSha,
    migrationTransactionId: bindings.journal.transactionId });
  const handle = await open(recordPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(parent);
  // After this durable transition, even a failed ingress attempt may have
  // accepted R0003 actions. All older snapshot rewind helpers reject it.
  await advanceMigrationJournal(bindings.intent.journalPath, "locally-healthy", "ingress-open");
  try {
    await removeMarker(marker);
    for (const unit of START) await startUnit(unit);
    await proof(boundary, false);
    for (const unit of START) {
      if (await getState(unit) !== "active") throw new Error(`Legacy ingress failed to start: ${unit}`);
    }
    if (await assertPublicLegacy() !== true) throw new Error("Public R0003 response not proven");
    await proof(boundary, false);
  } catch (error) {
    const failures = [];
    try {
      if (await absent(marker)) await restoreMarker(marker);
      else await verifyMarker(marker);
    } catch (markerError) { failures.push(markerError); }
    for (const unit of INGRESS) {
      try { await stopUnit(unit); }
      catch (stopError) { failures.push(stopError); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], "Legacy ingress release and closure failed");
    throw error;
  }
  const current = await readLegacyIngressRecord(recordPath);
  if (JSON.stringify(current) !== JSON.stringify(record)) throw new Error("Legacy ingress record changed");
  const next = validate({ ...record, phase: "exposed" });
  const temporary = `${recordPath}.${randomUUID()}.tmp`;
  const updated = await open(temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await updated.writeFile(JSON.stringify(next) + "\n"); await updated.sync(); }
  finally { await updated.close(); }
  await rename(temporary, recordPath);
  await syncDirectory(parent);
  return next;
}

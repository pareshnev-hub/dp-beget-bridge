import { execFile } from "node:child_process";
import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";
import { inspectInstalledIngressGuard } from "./installed-ingress-guard-preflight.mjs";
import { inspectInstalledWriterGuards } from "./installed-writer-guard-preflight.mjs";
import { readMigrationJournal, verifyJournalUnitBackup } from "./migration-journal.mjs";
import { verifyMarker } from "./quiesce-legacy-writers.mjs";
import { restoreStateBundle } from "./restore-state-bundle.mjs";
import { verifyJournalStateBundle } from "./snapshot-legacy-state.mjs";
import { WRITER_START_PERMIT } from "./writer-boot-guard.mjs";
import { assertWriterPermitAbsent } from "./writer-start-permit.mjs";

const exec = promisify(execFile);
const INGRESS = ["dp-beget-oauth-proxy.socket", "dp-beget-oauth-proxy.service", "dp-beget-tunnel.service"];
const RECOVERABLE_PHASES = ["snapshotted", "switched", "locally-healthy"];

async function systemctlState(unit) {
  const { stdout } = await exec("systemctl", ["show", unit, "--property=ActiveState", "--no-pager"],
    { timeout: 5000, maxBuffer: 4096 });
  if (!/^ActiveState=[a-z-]+\n$/.test(stdout)) throw new Error(`Invalid state for ${unit}`);
  return stdout.trim().slice("ActiveState=".length);
}

export async function assertPreExposureRecoveryBoundary({ journalPath, marker = PERSISTENT_MARKER,
  unitDirectory = "/etc/systemd/system", assertRouteExclusive,
  inspectGuard = inspectInstalledIngressGuard, getState = systemctlState,
  inspectWriterGuards = inspectInstalledWriterGuards, permit = WRITER_START_PERMIT,
  transactionId, phase, managedWriterView = phase !== "snapshotted" }) {
  if (process.getuid?.() !== 0 || typeof assertRouteExclusive !== "function") {
    throw new Error("Root and an exclusive route proof are required for recovery");
  }
  const journal = await readMigrationJournal(journalPath);
  if (journal.transactionId !== transactionId || journal.phase !== phase) {
    throw new Error("Migration changed during recovery staging");
  }
  try { await lstat(`${journalPath}.lock`); throw new Error("Migration transition lock requires inspection"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await verifyMarker(marker);
  await inspectGuard({ unitDirectory, marker });
  await inspectWriterGuards({ unitDirectory, marker, permit, managed: managedWriterView });
  await assertWriterPermitAbsent(permit);
  for (const unit of INGRESS) {
    if (await getState(unit) !== "inactive") throw new Error(`Ingress remains active: ${unit}`);
  }
  if (await assertRouteExclusive() !== true) throw new Error("Exclusive public OAuth route not proven");
}

// Stage and fully verify the grouped old state in a NEW private directory.
// This never stops a service, changes live data, moves a version pointer or
// removes the ingress guard. A later rollback controller must recheck the
// boundary immediately before replacing any live state.
export async function stagePreExposureRecovery({ journalPath, marker = PERSISTENT_MARKER,
  unitDirectory = "/etc/systemd/system", outputDir, assertRouteExclusive, permit = WRITER_START_PERMIT,
  inspectGuard = inspectInstalledIngressGuard, getState = systemctlState,
  inspectWriterGuards = inspectInstalledWriterGuards,
  restore = restoreStateBundle } = {}) {
  if (process.getuid?.() !== 0 || !path.isAbsolute(outputDir || "") ||
      path.normalize(outputDir) !== outputDir || typeof assertRouteExclusive !== "function") {
    throw new Error("Root, new absolute output directory and exclusive route proof are required");
  }
  const journal = await readMigrationJournal(journalPath);
  if (!RECOVERABLE_PHASES.includes(journal.phase)) {
    throw new Error("State rewind is forbidden after possible public exposure or before a snapshot");
  }
  await verifyJournalUnitBackup(journal);
  await verifyJournalStateBundle(journal);
  const boundary = { journalPath, marker, unitDirectory, assertRouteExclusive, inspectGuard,
    inspectWriterGuards, permit, getState,
    transactionId: journal.transactionId, phase: journal.phase };
  await assertPreExposureRecoveryBoundary(boundary);
  const result = await restore({ backupDir: journal.snapshotPath, outputDir });
  try {
    await assertPreExposureRecoveryBoundary(boundary);
    await verifyJournalUnitBackup(journal);
    await verifyJournalStateBundle(journal);
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
  return { transactionId: journal.transactionId, phase: journal.phase,
    directory: result.directory, databases: result.databases, configEntries: result.configEntries,
    sources: result.sources };
}

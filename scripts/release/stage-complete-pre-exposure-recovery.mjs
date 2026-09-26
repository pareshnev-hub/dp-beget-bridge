import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { inspectRecoveryDestinations } from "./inspect-recovery-destinations.mjs";
import { readMigrationJournal, verifyJournalUnitBackup } from "./migration-journal.mjs";
import { restoreSystemdUnitBackup } from "./restore-systemd-unit-backup.mjs";
import { assertPreExposureRecoveryBoundary, stagePreExposureRecovery } from "./stage-pre-exposure-recovery.mjs";
import { verifyJournalStateBundle } from "./snapshot-legacy-state.mjs";

function overlaps(first, second) {
  return first === second || first.startsWith(`${second}${path.sep}`) ||
    second.startsWith(`${first}${path.sep}`);
}

// Stage a matched original state + unit view under one NEW root. A later
// journaled controller must inspect live destinations and repeat the boundary
// checks immediately before any mutation.
export async function stageCompletePreExposureRecovery({ outputDir, stageUnits = restoreSystemdUnitBackup,
  inspectDestinations = inspectRecoveryDestinations,
  ...boundary } = {}) {
  if (process.getuid?.() !== 0 || !path.isAbsolute(outputDir || "") ||
      path.normalize(outputDir) !== outputDir || typeof boundary.assertRouteExclusive !== "function") {
    throw new Error("Root, new absolute recovery root and exclusive route proof are required");
  }
  const journal = await readMigrationJournal(boundary.journalPath);
  if (!["snapshotted", "switched", "locally-healthy"].includes(journal.phase)) {
    throw new Error("Original state staging is forbidden after possible public exposure");
  }
  const parent = path.dirname(outputDir);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.uid !== 0 || (parentInfo.mode & 0o022) !== 0 ||
      (await realpath(parent)) !== parent ||
      overlaps(outputDir, journal.snapshotPath) || overlaps(outputDir, journal.unitBackup.path)) {
    throw new Error("Recovery root must be separate from both trusted backups");
  }
  await mkdir(outputDir, { mode: 0o700 });
  try {
    const state = await stagePreExposureRecovery({ ...boundary, outputDir: path.join(outputDir, "state") });
    if (state.transactionId !== journal.transactionId || state.phase !== journal.phase) {
      throw new Error("Migration changed while staging recovery state");
    }
    const units = await stageUnits({ backupDir: journal.unitBackup.path,
      outputDir: path.join(outputDir, "units"),
      expectedManifestSha256: journal.unitBackup.manifestSha256 });
    const destinations = await inspectDestinations({ stagedDirectory: state.directory,
      sources: state.sources, databases: state.databases });
    await assertPreExposureRecoveryBoundary({ ...boundary,
      transactionId: journal.transactionId, phase: journal.phase });
    await verifyJournalUnitBackup(journal);
    await verifyJournalStateBundle(journal);
    if (units.manifestSha256 !== journal.unitBackup.manifestSha256) {
      throw new Error("Staged original units do not match the migration journal");
    }
    return { transactionId: journal.transactionId, phase: journal.phase, directory: outputDir,
      state, units, destinations };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

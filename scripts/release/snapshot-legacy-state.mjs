import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { backupStateBundle } from "./backup-state-bundle.mjs";
import { PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";
import { advanceMigrationJournal, readMigrationJournal, verifyJournalUnitBackup } from "./migration-journal.mjs";
import { verifyMarker } from "./quiesce-legacy-writers.mjs";
import { readRegularFile } from "./verify-artifact.mjs";

export async function verifyJournalStateBundle(record) {
  if (!record.snapshotPath || !/^[0-9a-f]{64}$/.test(record.snapshotSha256)) {
    throw new Error("Journal has no bound state snapshot");
  }
  const directory = await lstat(record.snapshotPath);
  if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o077) !== 0 ||
      (await realpath(record.snapshotPath)) !== record.snapshotPath) throw new Error("Untrusted state snapshot path");
  const filename = path.join(record.snapshotPath, "bundle-manifest.json");
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o077) !== 0 ||
      (await realpath(filename)) !== filename) throw new Error("Untrusted state snapshot manifest");
  const digest = createHash("sha256").update(await readRegularFile(filename, 16 * 1024)).digest("hex");
  if (digest !== record.snapshotSha256) throw new Error("State snapshot no longer matches the journal");
  return { manifestSha256: digest };
}

// Called only after all writers have stopped. The grouped backup checks this
// invariant both before and after copying, and syncs its contents before return.
export async function snapshotLegacyState({ journalPath, marker = PERSISTENT_MARKER,
  configRoot, databases, outputDir, backupBundle = backupStateBundle } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required for the migration snapshot");
  const journal = await readMigrationJournal(journalPath);
  if (journal.phase !== "quiesced") throw new Error("Legacy writers must be journaled quiesced first");
  if (!path.isAbsolute(outputDir || "") || path.normalize(outputDir) !== outputDir) {
    throw new Error("State snapshot requires a normalized absolute path");
  }
  await verifyJournalUnitBackup(journal);
  await verifyMarker(marker);
  await backupBundle({ configRoot, databases, outputDir });
  const filename = path.join(outputDir, "bundle-manifest.json");
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o077) !== 0) {
    throw new Error("Untrusted state snapshot manifest");
  }
  const snapshotSha256 = createHash("sha256").update(await readRegularFile(filename, 16 * 1024)).digest("hex");
  const next = await advanceMigrationJournal(journalPath, "quiesced", "snapshotted",
    { snapshotPath: outputDir, snapshotSha256 });
  await verifyJournalStateBundle(next);
  return { snapshotPath: outputDir, snapshotSha256 };
}

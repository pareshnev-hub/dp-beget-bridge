import { lstat } from "node:fs/promises";
import { readMigrationJournal, verifyJournalUnitBackup } from "./migration-journal.mjs";
import { PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";
import { verifyJournalStateBundle } from "./snapshot-legacy-state.mjs";

async function exists(filename) {
  try { return await lstat(filename); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// Read-only recovery assessment. It deliberately never removes the guard or lock.
export async function inspectMigrationRecovery({ journalPath, marker = PERSISTENT_MARKER }) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to inspect migration recovery");
  const [journalFile, lockFile, markerFile] = await Promise.all([
    exists(journalPath), exists(`${journalPath}.lock`), exists(marker)
  ]);
  if (!journalFile && !lockFile && !markerFile) return { state: "no-transaction", ingressMayOpen: false };
  if (!journalFile) return { state: "orphaned-lock-or-marker", ingressMayOpen: false };
  const journal = await readMigrationJournal(journalPath);
  await verifyJournalUnitBackup(journal);
  if (["snapshotted", "switched", "locally-healthy", "ingress-open", "completed"].includes(journal.phase)) {
    await verifyJournalStateBundle(journal);
  }
  if (markerFile && (!markerFile.isFile() || markerFile.nlink !== 1 || markerFile.uid !== 0 ||
      (markerFile.mode & 0o022) !== 0)) {
    throw new Error("Untrusted persistent migration marker");
  }
  if (lockFile && (!lockFile.isFile() || lockFile.nlink !== 1 || lockFile.uid !== 0 ||
      (lockFile.mode & 0o077) !== 0)) {
    throw new Error("Untrusted migration transition lock");
  }
  const closedPhase = ["ingress-closed", "quiesced", "snapshotted", "switched", "locally-healthy"]
    .includes(journal.phase);
  if (closedPhase && !markerFile) {
    return { state: "missing-guard-marker", phase: journal.phase, ingressMayOpen: false };
  }
  if (lockFile) return { state: "interrupted-transition", phase: journal.phase, ingressMayOpen: false };
  if (journal.phase === "ingress-open") {
    return { state: "possibly-exposed", phase: journal.phase, ingressMayOpen: false };
  }
  if (journal.phase !== "completed") {
    return { state: "incomplete-transaction", phase: journal.phase, ingressMayOpen: false };
  }
  if (markerFile) return { state: "completed-with-marker", phase: journal.phase, ingressMayOpen: false };
  return { state: "completed", phase: journal.phase, ingressMayOpen: false };
}

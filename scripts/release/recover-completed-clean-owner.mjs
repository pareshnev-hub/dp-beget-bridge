import { constants } from "node:fs";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { inspectCleanOwnerInstallBoundary, syncCleanOwnerDirectory } from "./install-clean-owner.mjs";
import { advanceCleanInstallJournal, readCleanInstallJournal } from "./clean-install-journal.mjs";

// Only after the original installer stopped. Completed exact owner data can
// advance; partial, altered, foreign or already granted state stays locked.
export async function recoverCompletedCleanOwner({ journalPath, trustDir,
  configDir = "/etc/dp-beget-bridge", unitDirectory = "/etc/systemd/system",
  dataRoot = "/var/lib", advance = advanceCleanInstallJournal } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to recover clean owner");
  const initial = await readCleanInstallJournal(journalPath);
  if (!["owner-intent", "owner-ready"].includes(initial.phase)) throw new Error("No clean owner installation to recover");
  const parent = path.dirname(journalPath), recovery = `${journalPath}.owner-recovery.lock`;
  const handle = await open(recovery, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${initial.transactionId}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncCleanOwnerDirectory(parent);
  try {
    const current = await readCleanInstallJournal(journalPath);
    if (JSON.stringify(current) !== JSON.stringify(initial)) throw new Error("Clean owner journal changed during recovery");
    const lock = `${journalPath}.owner-install.lock`, info = await lstat(lock);
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 ||
        info.size > 100 || await realpath(lock) !== lock || await readFile(lock, "utf8") !== `${current.transactionId}\n`) {
      throw new Error("Clean owner lock does not match this transaction");
    }
    try { await lstat(`${journalPath}.lock`); throw new Error("Unresolved clean journal transition"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await inspectCleanOwnerInstallBoundary({ journal: { ...current, journalPath }, trustDir,
      configDir, unitDirectory, dataRoot, expectOwner: true });
    const next = current.phase === "owner-ready" ? current : await advance({ journalPath,
      transactionId: current.transactionId, expectedPhase: "owner-intent", nextPhase: "owner-ready",
      trustDir, configDir, unitDirectory, dataRoot });
    await unlink(lock); await syncCleanOwnerDirectory(parent);
    return { phase: next.phase, transactionId: next.transactionId, owner: "candidate-bound" };
  } finally { await unlink(recovery); await syncCleanOwnerDirectory(parent); }
}

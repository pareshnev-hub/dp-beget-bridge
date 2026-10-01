import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_ADMISSION_PAUSE_PATH } from "../../packages/core/src/admission-gate.js";
import { pauseAdmission, verifyAdmissionPause } from "./admission-pause.mjs";
import { inspectCleanSystemdBoundary } from "./inspect-clean-systemd-boundary.mjs";
import { advanceCleanInstallJournal, readCleanInstallJournal } from "./clean-install-journal.mjs";

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function inspectCleanAdmissionTarget() {
  if (process.getuid?.() !== 0) throw new Error("Root is required to inspect clean admission target");
  try {
    await lstat(DEFAULT_ADMISSION_PAUSE_PATH);
    throw new Error("Clean-install admission flag already exists");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return { admission: "absent" };
}

// Establish the persistent gate before any service can be started. The same
// default path is consumed by MCP, Agent and Session Host; no alternate path
// is allowed in a clean-install transaction.
export async function installCleanAdmissionPause({ journalPath, trustDir,
  unitDirectory = "/etc/systemd/system", configDir = "/etc/dp-beget-bridge",
  dataRoot = "/var/lib", inspectSystemd = inspectCleanSystemdBoundary,
  inspectTarget = inspectCleanAdmissionTarget, pause = pauseAdmission,
  inspectPaused = verifyAdmissionPause, advance = advanceCleanInstallJournal } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to pause clean-install admission");
  const journal = await readCleanInstallJournal(journalPath);
  if (journal.phase !== "admission-intent") throw new Error("Admission pause requires journaled intent");
  async function preflight() {
    if ((await inspectSystemd({ journalPath, trustDir,
      unitDirectory }))?.localSystemd !== "inactive-bound" ||
        (await inspectTarget())?.admission !== "absent") {
      throw new Error("Clean-install service or admission state is unproven");
    }
  }
  await preflight();
  const parent = path.dirname(journalPath);
  const lock = `${journalPath}.admission-install.lock`;
  const handle = await open(lock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${journal.transactionId}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(parent);
  let mutationStarted = false;
  try {
    await preflight();
    mutationStarted = true;
    const result = await pause({ flag: DEFAULT_ADMISSION_PAUSE_PATH });
    if (result?.paused !== true || result.existing !== false ||
        (await inspectPaused({ flag: DEFAULT_ADMISSION_PAUSE_PATH }))?.paused !== true) {
      throw new Error("Clean-install admission pause is unproven");
    }
    const next = await advance({ journalPath, transactionId: journal.transactionId,
      expectedPhase: "admission-intent", nextPhase: "admission-ready",
      configDir, unitDirectory, dataRoot, trustDir });
    await unlink(lock);
    await syncDirectory(parent);
    return { transactionId: next.transactionId, phase: next.phase, admission: "paused" };
  } catch (error) {
    if (!mutationStarted) {
      await unlink(lock).catch(() => {});
      await syncDirectory(parent);
    }
    throw error;
  }
}

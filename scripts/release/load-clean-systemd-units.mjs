import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { inspectInstalledCleanUnits } from "./inspect-installed-clean-units.mjs";
import { inspectPromotedCleanRelease } from "./inspect-promoted-clean-release.mjs";
import { inspectCleanSystemdBoundary, inspectCleanSystemdInactivity } from
  "./inspect-clean-systemd-boundary.mjs";
import { advanceCleanInstallJournal, readCleanInstallJournal } from "./clean-install-journal.mjs";

const exec = promisify(execFile);

async function reloadSystemd() {
  await exec("systemctl", ["daemon-reload"], { timeout: 20000, maxBuffer: 4096 });
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// Load exact on-disk units into the manager while all seven reserved units
// remain inactive. Interruption after daemon-reload keeps a journal lock.
export async function loadCleanSystemdUnits({ journalPath, trustDir,
  unitDirectory = "/etc/systemd/system", configDir = "/etc/dp-beget-bridge",
  dataRoot = "/var/lib", inspectInstalled = inspectInstalledCleanUnits,
  inspectPointer = inspectPromotedCleanRelease,
  inspectInactive = inspectCleanSystemdInactivity,
  inspectBoundary = inspectCleanSystemdBoundary,
  reload = reloadSystemd, advance = advanceCleanInstallJournal } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to load clean systemd units");
  const journal = await readCleanInstallJournal(journalPath);
  if (journal.phase !== "systemd-intent") throw new Error("Systemd reload requires journaled intent");
  async function preflight() {
    if ((await inspectInstalled({ unitDirectory, workspace: journal.workspace,
      manifestSha256: journal.manifestSha256, trustDir }))?.units !== "bound-files" ||
        (await inspectPointer({ journal, trustDir,
          requireCurrent: true }))?.release !== "signed-inert" ||
        (await inspectInactive())?.localSystemd !== "inactive") {
      throw new Error("Clean-install systemd reload inputs are unproven");
    }
  }
  await preflight();
  const parent = path.dirname(journalPath);
  const lock = `${journalPath}.systemd-install.lock`;
  const handle = await open(lock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${journal.transactionId}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(parent);
  let mutationStarted = false;
  try {
    await preflight();
    mutationStarted = true;
    await reload();
    if ((await inspectBoundary({ journalPath, trustDir,
      unitDirectory }))?.localSystemd !== "inactive-bound") {
      throw new Error("Reloaded clean-install units are unproven");
    }
    const next = await advance({ journalPath, transactionId: journal.transactionId,
      expectedPhase: "systemd-intent", nextPhase: "systemd-ready", configDir,
      unitDirectory, dataRoot, trustDir });
    await unlink(lock);
    await syncDirectory(parent);
    return { transactionId: next.transactionId, phase: next.phase,
      localSystemd: "inactive-bound" };
  } catch (error) {
    if (!mutationStarted) {
      await unlink(lock).catch(() => {});
      await syncDirectory(parent);
    }
    throw error;
  }
}

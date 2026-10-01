import { constants } from "node:fs";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { verifyCleanInstallManifest } from "./clean-install-manifest.mjs";
import { inspectCleanInstallIdentityPlan } from "./clean-install-identity-plan.mjs";
import { inspectCreatedCleanIdentities } from "./inspect-clean-install-created-identities.mjs";
import { inspectInstalledCleanConfig } from "./inspect-installed-clean-config.mjs";
import { inspectInstalledCleanUnits } from "./inspect-installed-clean-units.mjs";
import { inspectCleanStartupData } from "./clean-install-data-directories.mjs";
import { inspectPromotedCleanRelease } from "./inspect-promoted-clean-release.mjs";
import { inspectCleanSystemdBoundary, inspectCleanRunningSystemd } from
  "./inspect-clean-systemd-boundary.mjs";
import { verifyAdmissionPause } from "./admission-pause.mjs";
import { localReleaseHealthProbes, waitForAdmissionDrain } from "./wait-admission-drain.mjs";
import { advanceCleanInstallJournal, readCleanInstallJournal,
  requireCleanClosedIngress } from "./clean-install-journal.mjs";

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function inspectLock(filename, transactionId) {
  const info = await lstat(filename);
  if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 || info.size > 100 ||
      await realpath(filename) !== filename ||
      await readFile(filename, "utf8") !== `${transactionId}\n`) {
    throw new Error("Clean startup lock does not match this transaction");
  }
}

// Call only after the original installer has stopped. An entirely inactive
// attempt may be retried; a fully healthy active attempt may be adopted.
// Partial or ambiguous service state keeps the startup lock in place.
export async function recoverCleanLocalStartup({ journalPath, trustDir,
  configDir = "/etc/dp-beget-bridge", unitDirectory = "/etc/systemd/system",
  dataRoot = "/var/lib", verify = verifyCleanInstallManifest,
  inspectPlan = inspectCleanInstallIdentityPlan,
  inspectCreated = inspectCreatedCleanIdentities,
  inspectConfig = inspectInstalledCleanConfig,
  inspectUnits = inspectInstalledCleanUnits,
  inspectData = inspectCleanStartupData,
  inspectPointer = inspectPromotedCleanRelease,
  inspectInactive = inspectCleanSystemdBoundary,
  inspectRunning = inspectCleanRunningSystemd,
  inspectPaused = verifyAdmissionPause,
  inspectClosedIngress = requireCleanClosedIngress,
  inspectHealth = () => waitForAdmissionDrain({ probes: localReleaseHealthProbes() }),
  advance = advanceCleanInstallJournal } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to recover clean local startup");
  const initial = await readCleanInstallJournal(journalPath);
  if (!["startup-intent", "startup-ready"].includes(initial.phase)) {
    throw new Error("No clean local startup to recover");
  }
  const parent = path.dirname(journalPath);
  const recoveryLock = `${journalPath}.startup-recovery.lock`;
  const handle = await open(recoveryLock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${initial.transactionId}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(parent);
  try {
    const current = await readCleanInstallJournal(journalPath);
    if (current.transactionId !== initial.transactionId || current.phase !== initial.phase) {
      throw new Error("Clean-install journal changed during startup recovery");
    }
    const lock = `${journalPath}.startup-install.lock`;
    await inspectLock(lock, current.transactionId);
    try {
      await lstat(`${journalPath}.lock`);
      throw new Error("Clean-install journal transition has an unresolved lock");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const candidate = await verify({ workspace: current.workspace,
      manifestSha256: current.manifestSha256, trustDir });
    if (candidate.artifactSha256 !== current.artifactSha256 ||
        candidate.version !== current.version || candidate.commit !== current.commit ||
        JSON.stringify(await inspectPlan({ workspace: current.workspace,
          manifestSha256: current.manifestSha256, trustDir })) !==
          JSON.stringify(current.identityPlan)) {
      throw new Error("Signed clean-install candidate changed during startup recovery");
    }
    const identities = await inspectCreated({ plan: current.identityPlan,
      transactionId: current.transactionId });
    if (identities?.identities !== "journal-bound" ||
        (await inspectConfig({ configDir, workspace: current.workspace,
          manifestSha256: current.manifestSha256, trustDir,
          identityPlan: current.identityPlan, identities }))?.config !== "bound-private" ||
        (await inspectUnits({ unitDirectory, workspace: current.workspace,
          manifestSha256: current.manifestSha256, trustDir }))?.units !== "bound-files" ||
        (await inspectData({ dataRoot, plan: current.identityPlan,
          identities }))?.data !== "private-owned" ||
        (await inspectPointer({ journal: current, trustDir,
          requireCurrent: true }))?.release !== "signed-inert" ||
        (await inspectPaused())?.paused !== true ||
        (await inspectClosedIngress())?.publicIngress !== "closed-exclusive") {
      throw new Error("Clean startup recovery inputs or closed route are unproven");
    }
    let inactive = false;
    if (current.phase === "startup-intent") {
      try {
        inactive = (await inspectInactive({ journalPath, trustDir,
          unitDirectory }))?.localSystemd === "inactive-bound";
      } catch { /* A partial manager is not an inactive retry. */ }
    }
    let next = current;
    if (!inactive) {
      if ((await inspectRunning({ journalPath, trustDir,
        unitDirectory }))?.localSystemd !== "active-bound" ||
          (await inspectHealth())?.drained !== true) {
        throw new Error("Clean startup is partial or paused health is unproven");
      }
      if (current.phase === "startup-intent") {
        next = await advance({ journalPath, transactionId: current.transactionId,
          expectedPhase: "startup-intent", nextPhase: "startup-ready",
          configDir, unitDirectory, dataRoot, trustDir,
          inspectClosedIngress, inspectRunning, inspectHealth, inspectPaused });
      }
    }
    if ((await inspectPaused())?.paused !== true ||
        (await inspectClosedIngress())?.publicIngress !== "closed-exclusive" ||
        (inactive
          ? (await inspectInactive({ journalPath, trustDir,
            unitDirectory }))?.localSystemd !== "inactive-bound"
          : (await inspectRunning({ journalPath, trustDir,
            unitDirectory }))?.localSystemd !== "active-bound" ||
            (await inspectHealth())?.drained !== true)) {
      throw new Error("Clean startup gate changed during recovery");
    }
    await unlink(lock);
    await syncDirectory(parent);
    return { transactionId: next.transactionId, phase: next.phase,
      localSystemd: inactive ? "inactive-bound" : "active-bound",
      admission: "paused" };
  } finally {
    await unlink(recoveryLock);
    await syncDirectory(parent);
  }
}

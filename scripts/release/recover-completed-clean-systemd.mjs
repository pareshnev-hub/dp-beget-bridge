import { constants } from "node:fs";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { verifyCleanInstallManifest } from "./clean-install-manifest.mjs";
import { inspectCleanInstallIdentityPlan } from "./clean-install-identity-plan.mjs";
import { inspectCreatedCleanIdentities } from "./inspect-clean-install-created-identities.mjs";
import { inspectInstalledCleanConfig } from "./inspect-installed-clean-config.mjs";
import { inspectInstalledCleanUnits } from "./inspect-installed-clean-units.mjs";
import { inspectInstalledCleanData } from "./clean-install-data-directories.mjs";
import { inspectPromotedCleanRelease } from "./inspect-promoted-clean-release.mjs";
import { inspectCleanSystemdBoundary } from "./inspect-clean-systemd-boundary.mjs";
import { advanceCleanInstallJournal, readCleanInstallJournal } from "./clean-install-journal.mjs";

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
    throw new Error("Clean-install systemd lock does not match this transaction");
  }
}

// Call after the original installer has stopped. A partially loaded manager,
// active unit or changed signed input leaves the install lock for review.
export async function recoverCompletedCleanSystemd({ journalPath, trustDir,
  configDir = "/etc/dp-beget-bridge", unitDirectory = "/etc/systemd/system",
  dataRoot = "/var/lib", verify = verifyCleanInstallManifest,
  inspectPlan = inspectCleanInstallIdentityPlan,
  inspectCreated = inspectCreatedCleanIdentities,
  inspectConfig = inspectInstalledCleanConfig,
  inspectUnits = inspectInstalledCleanUnits,
  inspectData = inspectInstalledCleanData,
  inspectPointer = inspectPromotedCleanRelease,
  inspectSystemd = inspectCleanSystemdBoundary,
  advance = advanceCleanInstallJournal } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to recover clean systemd reload");
  const initial = await readCleanInstallJournal(journalPath);
  if (!["systemd-intent", "systemd-ready"].includes(initial.phase)) {
    throw new Error("No clean-install systemd reload to recover");
  }
  const parent = path.dirname(journalPath);
  const recoveryLock = `${journalPath}.systemd-recovery.lock`;
  const handle = await open(recoveryLock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${initial.transactionId}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(parent);
  try {
    const current = await readCleanInstallJournal(journalPath);
    if (current.transactionId !== initial.transactionId || current.phase !== initial.phase) {
      throw new Error("Clean-install journal changed during systemd recovery");
    }
    const lock = `${journalPath}.systemd-install.lock`;
    await inspectLock(lock, current.transactionId);
    const candidate = await verify({ workspace: current.workspace,
      manifestSha256: current.manifestSha256, trustDir });
    if (candidate.artifactSha256 !== current.artifactSha256 ||
        candidate.version !== current.version || candidate.commit !== current.commit ||
        JSON.stringify(await inspectPlan({ workspace: current.workspace,
          manifestSha256: current.manifestSha256, trustDir })) !==
          JSON.stringify(current.identityPlan)) {
      throw new Error("Signed clean-install candidate changed during systemd recovery");
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
        (await inspectSystemd({ journalPath, trustDir,
          unitDirectory }))?.localSystemd !== "inactive-bound") {
      throw new Error("Clean-install systemd reload is incomplete or unproven");
    }
    const next = current.phase === "systemd-ready" ? current : await advance({ journalPath,
      transactionId: current.transactionId, expectedPhase: "systemd-intent",
      nextPhase: "systemd-ready", configDir, unitDirectory, dataRoot, trustDir });
    await unlink(lock);
    await syncDirectory(parent);
    return { transactionId: next.transactionId, phase: next.phase,
      localSystemd: "inactive-bound" };
  } finally {
    await unlink(recoveryLock);
    await syncDirectory(parent);
  }
}

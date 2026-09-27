import { constants } from "node:fs";
import { open, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { inspectCleanInstallIdentityPlan } from "./clean-install-identity-plan.mjs";
import { inspectCreatedCleanIdentities } from "./inspect-clean-install-created-identities.mjs";
import { inspectInstalledCleanConfig } from "./inspect-installed-clean-config.mjs";
import { inspectInstalledCleanUnits } from "./inspect-installed-clean-units.mjs";
import { inspectInstalledCleanData } from "./clean-install-data-directories.mjs";
import { inspectPromotedCleanRelease } from "./inspect-promoted-clean-release.mjs";
import { advanceCleanInstallJournal, readCleanInstallJournal } from "./clean-install-journal.mjs";

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// Create only the initial pointer to the signed inert release. No unit is
// started or reloaded; a failure after the link operation retains the lock.
export async function installCleanPointer({ journalPath, trustDir,
  configDir = "/etc/dp-beget-bridge", unitDirectory = "/etc/systemd/system",
  dataRoot = "/var/lib", inspectPlan = inspectCleanInstallIdentityPlan,
  inspectCreated = inspectCreatedCleanIdentities,
  inspectConfig = inspectInstalledCleanConfig,
  inspectUnits = inspectInstalledCleanUnits,
  inspectData = inspectInstalledCleanData,
  inspectPromoted = inspectPromotedCleanRelease,
  advance = advanceCleanInstallJournal } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to create clean release pointer");
  const journal = await readCleanInstallJournal(journalPath);
  if (journal.phase !== "pointer-intent") throw new Error("Clean pointer requires journaled intent");
  if (JSON.stringify(await inspectPlan({ workspace: journal.workspace,
    manifestSha256: journal.manifestSha256, trustDir })) !==
      JSON.stringify(journal.identityPlan)) {
    throw new Error("Signed clean-install identity plan changed");
  }
  const identities = await inspectCreated({ plan: journal.identityPlan,
    transactionId: journal.transactionId });
  if (identities?.identities !== "journal-bound" ||
      (await inspectConfig({ configDir, workspace: journal.workspace,
        manifestSha256: journal.manifestSha256, trustDir,
        identityPlan: journal.identityPlan, identities }))?.config !== "bound-private" ||
      (await inspectUnits({ unitDirectory, workspace: journal.workspace,
        manifestSha256: journal.manifestSha256, trustDir }))?.units !== "bound-files" ||
      (await inspectData({ dataRoot, plan: journal.identityPlan,
        identities }))?.data !== "private-owned" ||
      (await inspectPromoted({ journal, trustDir }))?.release !== "signed-inert") {
    throw new Error("Clean-install state is unproven before pointer creation");
  }
  const journalParent = path.dirname(journalPath);
  const lock = `${journalPath}.pointer-install.lock`;
  const handle = await open(lock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${journal.transactionId}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(journalParent);
  let mutationStarted = false;
  try {
    if ((await inspectPromoted({ journal, trustDir }))?.release !== "signed-inert") {
      throw new Error("Clean-install release changed before pointer creation");
    }
    mutationStarted = true;
    await symlink(`releases/${journal.version}-${journal.commit}`,
      path.join(journal.releaseRoot, "current"));
    await syncDirectory(journal.releaseRoot);
    if ((await inspectPromoted({ journal, trustDir,
      requireCurrent: true }))?.release !== "signed-inert") {
      throw new Error("Clean-install pointer is unproven");
    }
    const next = await advance({ journalPath, transactionId: journal.transactionId,
      expectedPhase: "pointer-intent", nextPhase: "pointer-ready",
      configDir, unitDirectory, dataRoot, trustDir });
    await unlink(lock);
    await syncDirectory(journalParent);
    return { transactionId: next.transactionId, phase: next.phase,
      current: `releases/${journal.version}-${journal.commit}` };
  } catch (error) {
    if (!mutationStarted) {
      await unlink(lock).catch(() => {});
      await syncDirectory(journalParent);
    }
    throw error;
  }
}

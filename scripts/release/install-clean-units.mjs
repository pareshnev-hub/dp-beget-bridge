import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { verifyCleanInstallManifest } from "./clean-install-manifest.mjs";
import { inspectCleanInstallIdentityPlan } from "./clean-install-identity-plan.mjs";
import { inspectCreatedCleanIdentities } from "./inspect-clean-install-created-identities.mjs";
import { inspectInstalledCleanConfig } from "./inspect-installed-clean-config.mjs";
import { advanceCleanInstallJournal, readCleanInstallJournal } from "./clean-install-journal.mjs";
import { CLEAN_INSTALL_UNIT_NAMES, inspectCleanInstallUnitTargets } from "./preflight-clean-install.mjs";
import { readRegularFile } from "./verify-artifact.mjs";

const FILES = CLEAN_INSTALL_UNIT_NAMES.slice(0, 3);

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// Installs only inert unit fragments. No daemon-reload, enable, start or
// ingress action is allowed at this journal boundary.
export async function installCleanUnits({ journalPath, trustDir,
  configDir = "/etc/dp-beget-bridge", unitDirectory = "/etc/systemd/system",
  verify = verifyCleanInstallManifest,
  inspectPlan = inspectCleanInstallIdentityPlan,
  inspectCreated = inspectCreatedCleanIdentities,
  inspectConfig = inspectInstalledCleanConfig,
  inspectTargets = inspectCleanInstallUnitTargets,
  advance = advanceCleanInstallJournal } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to install clean units");
  const journal = await readCleanInstallJournal(journalPath);
  if (journal.phase !== "units-intent") throw new Error("Unit installation requires journaled intent");
  const candidate = await verify({ workspace: journal.workspace,
    manifestSha256: journal.manifestSha256, trustDir });
  if (candidate.artifactSha256 !== journal.artifactSha256 ||
      candidate.version !== journal.version || candidate.commit !== journal.commit ||
      JSON.stringify(await inspectPlan({ workspace: journal.workspace,
        manifestSha256: journal.manifestSha256, trustDir })) !==
        JSON.stringify(journal.identityPlan)) {
    throw new Error("Signed clean-install unit candidate changed");
  }
  const identities = await inspectCreated({ plan: journal.identityPlan,
    transactionId: journal.transactionId });
  if (identities?.identities !== "journal-bound" ||
      (await inspectConfig({ configDir, workspace: journal.workspace,
        manifestSha256: journal.manifestSha256, trustDir,
        identityPlan: journal.identityPlan, identities }))?.config !== "bound-private") {
    throw new Error("Clean-install identities or configuration are unproven");
  }
  if ((await inspectTargets({ unitDirectory }))?.units !== "unoccupied") {
    throw new Error("Clean-install unit targets are occupied");
  }
  const journalParent = path.dirname(journalPath);
  const lock = `${journalPath}.unit-install.lock`;
  const handle = await open(lock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${journal.transactionId}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(journalParent);
  let mutationStarted = false;
  try {
    if ((await inspectTargets({ unitDirectory }))?.units !== "unoccupied") {
      throw new Error("Clean-install unit targets changed");
    }
    for (const name of FILES) {
      const bytes = await readRegularFile(path.join(journal.workspace,
        "clean-install", "units", name), 16 * 1024);
      mutationStarted = true;
      const unit = await open(path.join(unitDirectory, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await unit.writeFile(bytes); await unit.chmod(0o644); await unit.sync(); }
      finally { await unit.close(); }
    }
    await syncDirectory(unitDirectory);
    const next = await advance({ journalPath, transactionId: journal.transactionId,
      expectedPhase: "units-intent", nextPhase: "units-ready",
      configDir, unitDirectory, trustDir });
    await unlink(lock);
    await syncDirectory(journalParent);
    return { phase: next.phase, transactionId: next.transactionId,
      units: "bound-files" };
  } catch (error) {
    if (!mutationStarted) {
      await unlink(lock).catch(() => {});
      await syncDirectory(journalParent);
    }
    throw error;
  }
}

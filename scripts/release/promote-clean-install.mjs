import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { verifyCleanInstallManifest } from "./clean-install-manifest.mjs";
import { inspectCleanInstallIdentityPlan } from "./clean-install-identity-plan.mjs";
import { inspectCreatedCleanIdentities } from "./inspect-clean-install-created-identities.mjs";
import { inspectInstalledCleanConfig } from "./inspect-installed-clean-config.mjs";
import { inspectInstalledCleanUnits } from "./inspect-installed-clean-units.mjs";
import { inspectInstalledCleanData } from "./clean-install-data-directories.mjs";
import { inspectCreatedCleanReleaseRoot } from "./clean-install-release-root.mjs";
import { inspectPromotedCleanRelease } from "./inspect-promoted-clean-release.mjs";
import { promotePreparedRelease } from "./promote-prepared-release.mjs";
import { advanceCleanInstallJournal, readCleanInstallJournal } from "./clean-install-journal.mjs";

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// Moves only the signed prepared tree into an empty version root. A failure
// after starting promotion retains the lock; automatic retries never adopt a
// possibly moved tree. No current pointer or service state is changed.
export async function promoteCleanInstall({ journalPath, trustDir,
  configDir = "/etc/dp-beget-bridge", unitDirectory = "/etc/systemd/system",
  dataRoot = "/var/lib", verify = verifyCleanInstallManifest,
  inspectPlan = inspectCleanInstallIdentityPlan,
  inspectCreated = inspectCreatedCleanIdentities,
  inspectConfig = inspectInstalledCleanConfig,
  inspectUnits = inspectInstalledCleanUnits,
  inspectData = inspectInstalledCleanData,
  inspectReleaseRoot = inspectCreatedCleanReleaseRoot,
  inspectPromoted = inspectPromotedCleanRelease,
  promote = promotePreparedRelease,
  advance = advanceCleanInstallJournal } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to promote a clean release");
  const journal = await readCleanInstallJournal(journalPath);
  if (journal.phase !== "promotion-intent") throw new Error("Promotion requires journaled intent");
  const candidate = await verify({ workspace: journal.workspace,
    manifestSha256: journal.manifestSha256, trustDir });
  if (candidate.artifactSha256 !== journal.artifactSha256 ||
      candidate.version !== journal.version || candidate.commit !== journal.commit ||
      JSON.stringify(await inspectPlan({ workspace: journal.workspace,
        manifestSha256: journal.manifestSha256, trustDir })) !==
        JSON.stringify(journal.identityPlan)) {
    throw new Error("Signed clean-install promotion candidate changed");
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
      (await inspectReleaseRoot({ releaseRoot: journal.releaseRoot }))?.releaseRoot !== "private-empty") {
    throw new Error("Clean-install state is unproven before promotion");
  }
  const journalParent = path.dirname(journalPath);
  const lock = `${journalPath}.promotion-install.lock`;
  const handle = await open(lock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${journal.transactionId}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(journalParent);
  let mutationStarted = false;
  try {
    if ((await inspectReleaseRoot({ releaseRoot: journal.releaseRoot }))?.releaseRoot !== "private-empty") {
      throw new Error("Clean-install version root changed before promotion");
    }
    mutationStarted = true;
    const result = await promote({ workspace: journal.workspace,
      releaseRoot: journal.releaseRoot, trustDir });
    const versionDir = `${journal.version}-${journal.commit}`;
    if (result.versionDir !== versionDir || result.sha256 !== journal.artifactSha256 ||
        result.directory !== path.join(journal.releaseRoot, "releases", versionDir) ||
        (await inspectPromoted({ journal, trustDir }))?.release !== "signed-inert") {
      throw new Error("Promoted clean-install release is unproven");
    }
    const next = await advance({ journalPath, transactionId: journal.transactionId,
      expectedPhase: "promotion-intent", nextPhase: "promotion-ready",
      configDir, unitDirectory, dataRoot, trustDir });
    await unlink(lock);
    await syncDirectory(journalParent);
    return { transactionId: next.transactionId, phase: next.phase,
      versionDir, sha256: journal.artifactSha256 };
  } catch (error) {
    if (!mutationStarted) {
      await unlink(lock).catch(() => {});
      await syncDirectory(journalParent);
    }
    throw error;
  }
}

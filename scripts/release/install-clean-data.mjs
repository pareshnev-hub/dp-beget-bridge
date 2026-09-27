import { constants } from "node:fs";
import { chown, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { inspectCleanDataTargets, inspectCleanWorkIdentity } from "./clean-install-data-directories.mjs";
import { verifyCleanInstallManifest } from "./clean-install-manifest.mjs";
import { inspectCleanInstallIdentityPlan } from "./clean-install-identity-plan.mjs";
import { inspectCreatedCleanIdentities } from "./inspect-clean-install-created-identities.mjs";
import { inspectInstalledCleanConfig } from "./inspect-installed-clean-config.mjs";
import { inspectInstalledCleanUnits } from "./inspect-installed-clean-units.mjs";
import { advanceCleanInstallJournal, readCleanInstallJournal } from "./clean-install-journal.mjs";

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// Creates only new private state directories. No existing state is adopted or
// modified, and no service is enabled or started.
export async function installCleanData({ journalPath, trustDir,
  configDir = "/etc/dp-beget-bridge", unitDirectory = "/etc/systemd/system",
  dataRoot = "/var/lib", verify = verifyCleanInstallManifest,
  inspectPlan = inspectCleanInstallIdentityPlan,
  inspectCreated = inspectCreatedCleanIdentities,
  inspectWork = inspectCleanWorkIdentity,
  inspectConfig = inspectInstalledCleanConfig,
  inspectUnits = inspectInstalledCleanUnits,
  inspectTargets = inspectCleanDataTargets,
  advance = advanceCleanInstallJournal } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to install clean data directories");
  const journal = await readCleanInstallJournal(journalPath);
  if (journal.phase !== "data-intent") throw new Error("Data directories require journaled intent");
  const candidate = await verify({ workspace: journal.workspace,
    manifestSha256: journal.manifestSha256, trustDir });
  if (candidate.artifactSha256 !== journal.artifactSha256 ||
      candidate.version !== journal.version || candidate.commit !== journal.commit ||
      JSON.stringify(await inspectPlan({ workspace: journal.workspace,
        manifestSha256: journal.manifestSha256, trustDir })) !==
        JSON.stringify(journal.identityPlan)) {
    throw new Error("Signed clean-install data candidate changed");
  }
  const identities = await inspectCreated({ plan: journal.identityPlan,
    transactionId: journal.transactionId });
  const work = await inspectWork({ plan: journal.identityPlan });
  if (identities?.identities !== "journal-bound" ||
      [work.uid, work.gid, identities.agentUid, identities.agentGid,
        identities.mcpUid, identities.mcpGid].some(id => !Number.isSafeInteger(id) || id < 1) ||
      (await inspectConfig({ configDir, workspace: journal.workspace,
        manifestSha256: journal.manifestSha256, trustDir,
        identityPlan: journal.identityPlan, identities }))?.config !== "bound-private" ||
      (await inspectUnits({ unitDirectory, workspace: journal.workspace,
        manifestSha256: journal.manifestSha256, trustDir }))?.units !== "bound-files") {
    throw new Error("Clean-install accounts, configuration or units are unproven");
  }
  if ((await inspectTargets({ dataRoot }))?.data !== "unoccupied") {
    throw new Error("Clean-install data targets are occupied");
  }
  const journalParent = path.dirname(journalPath);
  const lock = `${journalPath}.data-install.lock`;
  const handle = await open(lock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${journal.transactionId}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(journalParent);
  let mutationStarted = false;
  try {
    if ((await inspectTargets({ dataRoot }))?.data !== "unoccupied") {
      throw new Error("Clean-install data targets changed");
    }
    const targets = [
      ["dp-beget-bridge", work.uid, work.gid],
      ["dp-beget-bridge-agent", identities.agentUid, identities.agentGid],
      ["dp-beget-bridge-mcp", identities.mcpUid, identities.mcpGid]
    ];
    for (const [name, uid, gid] of targets) {
      const directory = path.join(dataRoot, name);
      mutationStarted = true;
      await mkdir(directory, { mode: 0o700 });
      await chown(directory, uid, gid);
      await syncDirectory(directory);
    }
    const tmux = path.join(dataRoot, "dp-beget-bridge", "tmux");
    await mkdir(tmux, { mode: 0o700 });
    await chown(tmux, work.uid, work.gid);
    await syncDirectory(tmux);
    await syncDirectory(path.dirname(tmux));
    await syncDirectory(dataRoot);
    const next = await advance({ journalPath, transactionId: journal.transactionId,
      expectedPhase: "data-intent", nextPhase: "data-ready",
      configDir, unitDirectory, dataRoot, trustDir });
    await unlink(lock);
    await syncDirectory(journalParent);
    return { phase: next.phase, transactionId: next.transactionId,
      data: "private-owned" };
  } catch (error) {
    if (!mutationStarted) {
      await unlink(lock).catch(() => {});
      await syncDirectory(journalParent);
    }
    throw error;
  }
}

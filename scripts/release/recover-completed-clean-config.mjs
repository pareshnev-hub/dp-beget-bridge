import { constants } from "node:fs";
import { lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { verifyCleanInstallManifest } from "./clean-install-manifest.mjs";
import { inspectCleanInstallIdentityPlan } from "./clean-install-identity-plan.mjs";
import { inspectCreatedCleanIdentities } from "./inspect-clean-install-created-identities.mjs";
import { inspectInstalledCleanConfig } from "./inspect-installed-clean-config.mjs";
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
    throw new Error("Clean-install configuration lock does not match this transaction");
  }
}

// Call after confirming the original installer has stopped. Incomplete or
// altered destination files stay locked and require manual investigation.
export async function recoverCompletedCleanConfig({ journalPath, trustDir,
  configDir = "/etc/dp-beget-bridge", verify = verifyCleanInstallManifest,
  inspectPlan = inspectCleanInstallIdentityPlan,
  inspectCreated = inspectCreatedCleanIdentities,
  inspectConfig = inspectInstalledCleanConfig,
  advance = advanceCleanInstallJournal } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to recover clean configuration");
  const initial = await readCleanInstallJournal(journalPath);
  if (!["config-intent", "config-ready"].includes(initial.phase)) {
    throw new Error("No clean-install configuration to recover");
  }
  const parent = path.dirname(journalPath);
  const recoveryLock = `${journalPath}.config-recovery.lock`;
  const handle = await open(recoveryLock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${initial.transactionId}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(parent);
  try {
    const current = await readCleanInstallJournal(journalPath);
    if (current.transactionId !== initial.transactionId || current.phase !== initial.phase) {
      throw new Error("Clean-install journal changed during configuration recovery");
    }
    const lock = `${journalPath}.config-install.lock`;
    await inspectLock(lock, current.transactionId);
    const candidate = await verify({ workspace: current.workspace,
      manifestSha256: current.manifestSha256, trustDir });
    if (candidate.artifactSha256 !== current.artifactSha256 ||
        candidate.version !== current.version || candidate.commit !== current.commit ||
        JSON.stringify(await inspectPlan({ workspace: current.workspace,
          manifestSha256: current.manifestSha256, trustDir })) !==
          JSON.stringify(current.identityPlan)) {
      throw new Error("Signed clean-install candidate changed during configuration recovery");
    }
    const identities = await inspectCreated({ plan: current.identityPlan,
      transactionId: current.transactionId });
    if (identities?.identities !== "journal-bound" ||
        (await inspectConfig({ configDir, workspace: current.workspace,
          manifestSha256: current.manifestSha256, trustDir,
          identityPlan: current.identityPlan, identities }))?.config !== "bound-private") {
      throw new Error("Installed clean-install configuration is incomplete or unproven");
    }
    const next = current.phase === "config-ready" ? current : await advance({ journalPath,
      transactionId: current.transactionId, expectedPhase: "config-intent",
      nextPhase: "config-ready", configDir, trustDir });
    await unlink(lock);
    await syncDirectory(parent);
    return { transactionId: next.transactionId, phase: next.phase,
      config: "bound-private" };
  } finally {
    await unlink(recoveryLock);
    await syncDirectory(parent);
  }
}

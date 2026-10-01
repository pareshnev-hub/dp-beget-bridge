import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { loadCleanInstallAuthConfiguration } from "./clean-install-auth-profile.mjs";
import { inspectCreatedCleanIdentities } from "./inspect-clean-install-created-identities.mjs";
import { inspectInstalledCleanConfig } from "./inspect-installed-clean-config.mjs";
import { inspectInstalledCleanData } from "./clean-install-data-directories.mjs";
import { inspectInitializedCleanOwner } from "./clean-install-owner-data.mjs";
import { inspectCleanSystemdBoundary } from "./inspect-clean-systemd-boundary.mjs";
import { verifyAdmissionPause } from "./admission-pause.mjs";
import { advanceCleanInstallJournal, readCleanInstallJournal } from "./clean-install-journal.mjs";

const exec = promisify(execFile);
export async function syncCleanOwnerDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// Internal boundary returns credentials solely for the child process env.
// Never print or serialize this object.
export async function inspectCleanOwnerInstallBoundary({ journal, trustDir,
  dataRoot = "/var/lib", configDir = "/etc/dp-beget-bridge",
  unitDirectory = "/etc/systemd/system", expectOwner = false } = {}) {
  const profile = await loadCleanInstallAuthConfiguration({ workspace: journal.workspace,
    manifestSha256: journal.manifestSha256, trustDir });
  if (profile.authMode !== "oauth" || !isDeepStrictEqual(profile.plan, journal.identityPlan)) {
    throw new Error("Clean owner requires exact bound OAuth profile");
  }
  const identities = await inspectCreatedCleanIdentities({ plan: journal.identityPlan, transactionId: journal.transactionId });
  if ((await inspectInstalledCleanConfig({ configDir, workspace: journal.workspace,
    manifestSha256: journal.manifestSha256, trustDir, identityPlan: journal.identityPlan, identities }))?.config !== "bound-private" ||
      (await inspectInstalledCleanData({ dataRoot, plan: journal.identityPlan, identities,
        authMode: "oauth", ownerReady: expectOwner }))?.data !== "private-owned" ||
      (await inspectCleanSystemdBoundary({ journalPath: journal.journalPath, trustDir, unitDirectory }))?.localSystemd !== "inactive-bound" ||
      (await verifyAdmissionPause())?.paused !== true ||
      (expectOwner && (await inspectInitializedCleanOwner({ journal, trustDir, dataRoot }))?.owner !== "candidate-bound")) {
    throw new Error("Clean owner inactive installation boundary is unproven");
  }
  return profile;
}

async function bootstrapOwner({ journal, profile, dataRoot }) {
  try {
    await exec("runuser", ["-u", journal.identityPlan.mcpUser, "--", process.execPath,
      path.join(journal.releaseRoot, "current", "scripts", "auth-bootstrap.mjs")], {
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        HOME: path.join(dataRoot, "dp-beget-bridge-mcp"),
        DP_AUTH_DATA_DIR: path.join(dataRoot, "dp-beget-bridge-mcp", "auth"),
        DP_OWNER_ID: profile.ownerId, DP_OWNER_BOOTSTRAP_SECRET: profile.approvalSecret },
      timeout: 15000, maxBuffer: 4096 });
  } catch { throw new Error("Clean owner bootstrap command failed; credentials withheld"); }
}

// New owner only, never adopt existing or partial databases. The durable
// intent/lock survives any begun command failure for explicit recovery.
export async function installCleanOwner({ journalPath, trustDir,
  configDir = "/etc/dp-beget-bridge", unitDirectory = "/etc/systemd/system",
  dataRoot = "/var/lib", bootstrap = bootstrapOwner,
  advance = advanceCleanInstallJournal } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to install clean owner");
  const journal = await readCleanInstallJournal(journalPath);
  if (journal.phase !== "owner-intent") throw new Error("Clean owner requires journaled intent");
  const common = { journal: { ...journal, journalPath }, trustDir, configDir, unitDirectory, dataRoot };
  await inspectCleanOwnerInstallBoundary(common);
  const parent = path.dirname(journalPath), lock = `${journalPath}.owner-install.lock`;
  const handle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${journal.transactionId}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncCleanOwnerDirectory(parent);
  let begun = false;
  try {
    const profile = await inspectCleanOwnerInstallBoundary(common);
    // A separate journal transition lock must never overlap a live command.
    try { await lstat(`${journalPath}.lock`); throw new Error("Unresolved clean journal transition"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    begun = true;
    await bootstrap({ journal, profile, dataRoot });
    await inspectCleanOwnerInstallBoundary({ ...common, expectOwner: true });
    await syncCleanOwnerDirectory(path.join(dataRoot, "dp-beget-bridge-mcp", "auth"));
    await syncCleanOwnerDirectory(path.join(dataRoot, "dp-beget-bridge-mcp"));
    const next = await advance({ journalPath, transactionId: journal.transactionId,
      expectedPhase: "owner-intent", nextPhase: "owner-ready", trustDir, configDir, unitDirectory, dataRoot });
    await unlink(lock); await syncCleanOwnerDirectory(parent);
    return { phase: next.phase, transactionId: next.transactionId, owner: "candidate-bound" };
  } catch (error) {
    if (!begun) { await unlink(lock).catch(() => {}); await syncCleanOwnerDirectory(parent); }
    throw error;
  }
}

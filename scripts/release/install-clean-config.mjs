import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { verifyCleanInstallManifest } from "./clean-install-manifest.mjs";
import { inspectCleanInstallIdentityPlan } from "./clean-install-identity-plan.mjs";
import { inspectCreatedCleanIdentities } from "./inspect-clean-install-created-identities.mjs";
import { advanceCleanInstallJournal, readCleanInstallJournal } from "./clean-install-journal.mjs";
import { readRegularFile } from "./verify-artifact.mjs";
import { configureCleanWorkspace } from "./clean-install-workspace.mjs";

const FILES = ["session-host.env", "agent.env", "mcp.env"];

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function missing(filename) {
  try { await lstat(filename); throw new Error("Clean-install configuration target already exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function safeParent(configDir) {
  if (typeof configDir !== "string" || !path.isAbsolute(configDir) ||
      path.normalize(configDir) !== configDir || configDir === "/") {
    throw new Error("Invalid clean-install configuration directory");
  }
  const parent = path.dirname(configDir);
  const info = await stat(parent);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
      await realpath(parent) !== parent) throw new Error("Untrusted configuration parent");
  return parent;
}

// These files are inert until the later journaled unit and release activation.
// A partial copy retains both locks and never overwrites an existing file.
export async function installCleanConfig({ journalPath, trustDir,
  configDir = "/etc/dp-beget-bridge", verify = verifyCleanInstallManifest,
  inspectPlan = inspectCleanInstallIdentityPlan,
  inspectCreated = inspectCreatedCleanIdentities,
  configureWorkspace = configureCleanWorkspace,
  advance = advanceCleanInstallJournal } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to install clean configuration");
  const journal = await readCleanInstallJournal(journalPath);
  if (journal.phase !== "config-intent") throw new Error("Configuration requires journaled intent");
  const parent = await safeParent(configDir);
  const candidate = await verify({ workspace: journal.workspace,
    manifestSha256: journal.manifestSha256, trustDir });
  if (candidate.artifactSha256 !== journal.artifactSha256 ||
      candidate.version !== journal.version || candidate.commit !== journal.commit ||
      JSON.stringify(await inspectPlan({ workspace: journal.workspace,
        manifestSha256: journal.manifestSha256, trustDir })) !==
        JSON.stringify(journal.identityPlan)) {
    throw new Error("Clean-install configuration candidate changed");
  }
  const identities = await inspectCreated({ plan: journal.identityPlan,
    transactionId: journal.transactionId });
  if (identities?.identities !== "journal-bound" ||
      [identities.ipcGid, identities.agentGid, identities.mcpGid].some(gid =>
        !Number.isSafeInteger(gid) || gid < 1)) {
    throw new Error("Service groups are unproven");
  }
  await missing(configDir);
  const lock = `${journalPath}.config-install.lock`;
  const journalParent = path.dirname(journalPath);
  const handle = await open(lock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${journal.transactionId}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(journalParent);
  let mutationStarted = false;
  try {
    await missing(configDir);
    mutationStarted = true;
    await configureWorkspace({ identityPlan: journal.identityPlan, identities });
    await mkdir(configDir, { mode: 0o700 });
    await chmod(configDir, 0o711);
    await syncDirectory(parent);
    const gids = { "session-host.env": identities.ipcGid,
      "agent.env": identities.agentGid, "mcp.env": identities.mcpGid };
    for (const name of FILES) {
      const bytes = await readRegularFile(
        path.join(journal.workspace, "clean-install", "config", name), 16 * 1024);
      const file = await open(path.join(configDir, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(bytes);
        await file.chown(0, gids[name]);
        await file.chmod(0o640);
        await file.sync();
      } finally { await file.close(); }
    }
    await syncDirectory(configDir);
    const next = await advance({ journalPath, transactionId: journal.transactionId,
      expectedPhase: "config-intent", nextPhase: "config-ready", configDir, trustDir });
    await unlink(lock);
    await syncDirectory(journalParent);
    return { phase: next.phase, transactionId: next.transactionId,
      config: "bound-private" };
  } catch (error) {
    if (!mutationStarted) {
      await unlink(lock).catch(() => {});
      await syncDirectory(journalParent);
    }
    throw error;
  }
}

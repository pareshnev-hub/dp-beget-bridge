import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { inspectCleanInstallIdentityPlan } from "./clean-install-identity-plan.mjs";
import { inspectCleanInstallIdentities } from "./preflight-clean-install-identities.mjs";
import { advanceCleanInstallJournal, readCleanInstallJournal } from "./clean-install-journal.mjs";

const exec = promisify(execFile);

async function createGroup(name) {
  await exec("groupadd", ["--system", "--", name], { timeout: 10000, maxBuffer: 4096 });
}

async function createUser(name, transactionId, home) {
  await exec("useradd", ["--system", "--gid", name,
    "--home-dir", home,
    "--no-create-home", "--shell", "/usr/sbin/nologin",
    "--comment", `DP Beget clean install ${transactionId}`, "--", name],
  { timeout: 10000, maxBuffer: 4096 });
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// This first mutation is deliberately non-idempotent. If an account tool
// returns after a partial change or the host crashes, the lock remains and
// automated retry refuses to adopt an identity that might belong to someone
// else. A separate evidence-based recovery path is required.
export async function installCleanIdentities({ journalPath, trustDir,
  inspectAvailable = inspectCleanInstallIdentities,
  inspectPlan = inspectCleanInstallIdentityPlan,
  addGroup = createGroup, addUser = createUser,
  advance = advanceCleanInstallJournal } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to create clean-install identities");
  const journal = await readCleanInstallJournal(journalPath);
  if (journal.phase !== "identities-intent") throw new Error("Identity creation requires journaled intent");
  const plan = journal.identityPlan;
  if (JSON.stringify(await inspectPlan({ workspace: journal.workspace,
    manifestSha256: journal.manifestSha256, trustDir })) !== JSON.stringify(plan)) {
    throw new Error("Signed clean-install identity plan changed");
  }
  await inspectAvailable({ ...plan });
  const parent = path.dirname(journalPath);
  const lock = `${journalPath}.identity-install.lock`;
  const handle = await open(lock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${journal.transactionId}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(parent);
  let mutationStarted = false;
  try {
    await inspectAvailable({ ...plan });
    for (const name of [plan.ipcGroup, plan.agentUser, plan.mcpUser]) {
      mutationStarted = true;
      await addGroup(name);
    }
    // The service processes gain IPC access through systemd Group and
    // SupplementaryGroups; the existing work account is never usermod'd.
    await addUser(plan.agentUser, journal.transactionId, "/var/lib/dp-beget-bridge-agent");
    await addUser(plan.mcpUser, journal.transactionId, "/var/lib/dp-beget-bridge-mcp");
    const next = await advance({ journalPath, transactionId: journal.transactionId,
      expectedPhase: "identities-intent", nextPhase: "identities-ready", trustDir });
    await unlink(lock);
    await syncDirectory(parent);
    return { transactionId: next.transactionId, phase: next.phase,
      identities: "journal-bound" };
  } catch (error) {
    if (!mutationStarted) {
      await unlink(lock).catch(() => {});
      await syncDirectory(parent);
    }
    throw error;
  }
}

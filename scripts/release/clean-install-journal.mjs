import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { verifyCleanInstallManifest } from "./clean-install-manifest.mjs";
import { inspectCleanInstallIdentityPlan } from "./clean-install-identity-plan.mjs";
import { inspectCreatedCleanIdentities } from "./inspect-clean-install-created-identities.mjs";

const SHA = /^[0-9a-f]{64}$/;
// Later phases must be added together with real boundary verifiers.
const PHASES = ["prepared", "identities-intent", "identities-ready"];
const FORMAT = "dp-beget-clean-install-journal-v1";

async function privateParent(filename) {
  if (typeof filename !== "string" || !path.isAbsolute(filename) ||
      path.normalize(filename) !== filename) throw new Error("Invalid clean-install journal path");
  const parent = path.dirname(filename);
  const info = await stat(parent);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o077) !== 0 ||
      (await realpath(parent)) !== parent) throw new Error("Untrusted clean-install journal parent");
  return parent;
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

function validate(record) {
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      Object.keys(record).sort().join(",") !==
        "artifactSha256,commit,format,identityPlan,manifestSha256,phase,releaseRoot,transactionId,version,workspace" ||
      record.format !== FORMAT || !PHASES.includes(record.phase) ||
      !/^[0-9a-f-]{36}$/.test(record.transactionId || "") ||
      !SHA.test(record.artifactSha256 || "") || !SHA.test(record.manifestSha256 || "") ||
      !/^[0-9a-f]{40}$/.test(record.commit || "") ||
      typeof record.version !== "string" ||
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(record.version) ||
      [record.workspace, record.releaseRoot].some(value => typeof value !== "string" ||
        !path.isAbsolute(value) || path.normalize(value) !== value) ||
      record.workspace === record.releaseRoot ||
      record.workspace.startsWith(`${record.releaseRoot}/`) ||
      record.releaseRoot.startsWith(`${record.workspace}/`) ||
      !record.identityPlan || typeof record.identityPlan !== "object" ||
      Object.keys(record.identityPlan).sort().join(",") !==
        "agentUser,allowedRoot,domain,ipcGroup,mcpUser,releaseRoot,workGroup,workUser" ||
      record.identityPlan.releaseRoot !== record.releaseRoot ||
      ["workUser", "workGroup", "ipcGroup", "agentUser", "mcpUser"].some(key =>
        !/^[a-z_][a-z0-9_-]{0,31}$/.test(record.identityPlan[key] || "") ||
        record.identityPlan[key] === "root") ||
      typeof record.identityPlan.allowedRoot !== "string" ||
      !path.isAbsolute(record.identityPlan.allowedRoot) ||
      typeof record.identityPlan.domain !== "string" ||
      !/^[a-z0-9.-]+$/.test(record.identityPlan.domain)) {
    throw new Error("Invalid clean-install journal");
  }
  return record;
}

export async function readCleanInstallJournal(journalPath) {
  await privateParent(journalPath);
  const info = await lstat(journalPath);
  if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 || info.size > 4096 ||
      (await realpath(journalPath)) !== journalPath) throw new Error("Untrusted clean-install journal");
  return validate(JSON.parse(await readFile(journalPath, "utf8")));
}

// The journal is placed outside the candidate workspace so interruption of
// later live mutations cannot remove its recovery record with the workspace.
export async function startCleanInstallJournal({ journalPath, workspace, manifestSha256,
  releaseRoot, trustDir, verify = verifyCleanInstallManifest,
  inspectPlan = inspectCleanInstallIdentityPlan } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to start a clean-install journal");
  const parent = await privateParent(journalPath);
  const candidate = await verify({ workspace, manifestSha256, trustDir });
  const identityPlan = await inspectPlan({ workspace, manifestSha256, trustDir });
  const record = validate({ format: FORMAT, transactionId: randomUUID(), phase: "prepared",
    workspace, releaseRoot, manifestSha256, artifactSha256: candidate.artifactSha256,
    version: candidate.version, commit: candidate.commit, identityPlan });
  const handle = await open(journalPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(parent);
  return record;
}

export async function advanceCleanInstallJournal({ journalPath, transactionId,
  expectedPhase, nextPhase, verify = verifyCleanInstallManifest,
  inspectPlan = inspectCleanInstallIdentityPlan,
  inspectCreated = inspectCreatedCleanIdentities, trustDir } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to advance a clean-install journal");
  const parent = await privateParent(journalPath);
  const lock = `${journalPath}.lock`;
  const handle = await open(lock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile("clean install transition in progress\n"); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(parent);
  try {
    const current = await readCleanInstallJournal(journalPath);
    if (current.transactionId !== transactionId || current.phase !== expectedPhase ||
        PHASES.indexOf(nextPhase) !== PHASES.indexOf(expectedPhase) + 1) {
      throw new Error("Clean-install journal transition rejected");
    }
    const candidate = await verify({ workspace: current.workspace,
      manifestSha256: current.manifestSha256, trustDir });
    if (candidate.artifactSha256 !== current.artifactSha256 ||
        candidate.commit !== current.commit || candidate.version !== current.version) {
      throw new Error("Clean-install candidate changed during transaction");
    }
    if (JSON.stringify(await inspectPlan({ workspace: current.workspace,
      manifestSha256: current.manifestSha256, trustDir })) !==
        JSON.stringify(current.identityPlan)) {
      throw new Error("Clean-install identity plan changed during transaction");
    }
    if (nextPhase === "identities-ready" &&
        (await inspectCreated({ plan: current.identityPlan,
          transactionId: current.transactionId }))?.identities !== "journal-bound") {
      throw new Error("Created clean-install identities are unproven");
    }
    const next = validate({ ...current, phase: nextPhase });
    const temporary = `${journalPath}.${randomUUID()}.tmp`;
    const output = await open(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await output.writeFile(JSON.stringify(next) + "\n"); await output.sync(); }
    finally { await output.close(); }
    try { await rename(temporary, journalPath); await syncDirectory(parent); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    await unlink(lock);
    await syncDirectory(parent);
    return next;
  } catch (error) {
    // An interrupted rename/sync leaves the lock for deliberate recovery.
    // Validation failures before the new journal exists can be retried.
    if (error.code === "ENOENT" || /transition rejected|candidate changed/.test(error.message)) {
      await unlink(lock).catch(() => {});
      await syncDirectory(parent);
    }
    throw error;
  }
}

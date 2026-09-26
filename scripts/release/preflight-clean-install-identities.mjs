import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

function name(value) {
  if (typeof value !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(value) || value === "root") {
    throw new Error("Unsafe clean-install identity name");
  }
  return value;
}

async function lookup(kind, value) {
  try {
    const { stdout } = await exec("getent", [kind, value], { timeout: 5000, maxBuffer: 4096 });
    if (!stdout.startsWith(`${value}:`)) throw new Error("Invalid identity lookup response");
    return true;
  } catch (error) {
    if (error.code === 2) return false;
    throw error;
  }
}

async function workIdentity(value, field) {
  const { stdout } = await exec("id", [field, value], { timeout: 5000, maxBuffer: 4096 });
  return stdout.trim();
}

// A clean install must not take over existing service identities. The existing
// work account owns its workspace; the future installer creates three groups
// and two non-login service accounts under a journaled transaction.
export async function inspectCleanInstallIdentities({ workUser, workGroup, agentUser,
  mcpUser, ipcGroup, allowedRoot, hasIdentity = lookup, inspectWork = workIdentity,
  inspectPath = lstat, resolvePath = realpath } = {}) {
  for (const value of [workUser, workGroup, agentUser, mcpUser, ipcGroup]) name(value);
  if (new Set([workUser, agentUser, mcpUser]).size !== 3 ||
      new Set([workGroup, agentUser, mcpUser, ipcGroup]).size !== 4) {
    throw new Error("Clean-install identities must be distinct");
  }
  if (typeof allowedRoot !== "string" || !path.isAbsolute(allowedRoot) ||
      path.normalize(allowedRoot) !== allowedRoot) throw new Error("Unsafe work directory");
  const uid = Number(await inspectWork(workUser, "-u"));
  if (!Number.isSafeInteger(uid) || uid < 1 ||
      await inspectWork(workUser, "-gn") !== workGroup ||
      !(await hasIdentity("group", workGroup))) {
    throw new Error("Existing work identity does not match the selected primary group");
  }
  for (const value of [agentUser, mcpUser]) {
    if (await hasIdentity("passwd", value) || await hasIdentity("group", value)) {
      throw new Error(`Reserved service identity already exists: ${value}`);
    }
  }
  if (await hasIdentity("group", ipcGroup)) throw new Error("Reserved IPC group already exists");
  const info = await inspectPath(allowedRoot);
  if (!info.isDirectory() || info.uid !== uid || (info.mode & 0o007) !== 0 ||
      (await resolvePath(allowedRoot)) !== allowedRoot) {
    throw new Error("Work directory is not private and owned by the work identity");
  }
  return { workIdentity: "existing-non-root", reservedIdentities: "unoccupied",
    workDirectory: "private-owned" };
}

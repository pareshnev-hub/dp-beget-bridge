import { execFile } from "node:child_process";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const NAMES = ["dp-beget-bridge", "dp-beget-bridge-agent", "dp-beget-bridge-mcp"];

async function safeParent(dataRoot) {
  if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot) ||
      path.normalize(dataRoot) !== dataRoot || dataRoot === "/") {
    throw new Error("Absolute data parent is required");
  }
  const info = await stat(dataRoot);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
      await realpath(dataRoot) !== dataRoot) throw new Error("Untrusted data parent");
}

async function missing(filename) {
  try { await lstat(filename); throw new Error("Clean-install data directory already exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

export async function inspectCleanDataTargets({ dataRoot = "/var/lib" } = {}) {
  await safeParent(dataRoot);
  for (const name of NAMES) await missing(path.join(dataRoot, name));
  return { data: "unoccupied" };
}

async function getent(kind, name) {
  const { stdout } = await exec("getent", [kind, name], { timeout: 5000, maxBuffer: 4096 });
  return stdout.trim().split(":");
}

export async function inspectCleanWorkIdentity({ plan, lookup = getent } = {}) {
  const user = await lookup("passwd", plan.workUser);
  const group = await lookup("group", plan.workGroup);
  const uid = Number(user[2]);
  const gid = Number(group[2]);
  if (user.length !== 7 || user[0] !== plan.workUser || group.length !== 4 ||
      group[0] !== plan.workGroup || !Number.isSafeInteger(uid) || uid < 1 ||
      !Number.isSafeInteger(gid) || gid < 1 || Number(user[3]) !== gid) {
    throw new Error("Clean-install work account changed");
  }
  return { uid, gid };
}

// Before activation the work state contains only its tmux directory. All
// three paths must be private and owned by their journal-bound accounts.
export async function inspectInstalledCleanData({ dataRoot = "/var/lib", plan,
  identities, inspectWork = inspectCleanWorkIdentity } = {}) {
  await safeParent(dataRoot);
  if (identities?.identities !== "journal-bound") {
    throw new Error("Journal-bound service identities are required for data directories");
  }
  const work = await inspectWork({ plan });
  const expected = [
    [NAMES[0], work.uid, work.gid, ["tmux"]],
    [NAMES[1], identities.agentUid, identities.agentGid, []],
    [NAMES[2], identities.mcpUid, identities.mcpGid, []]
  ];
  for (const [name, uid, gid, children] of expected) {
    if (![uid, gid].every(id => Number.isSafeInteger(id) && id > 0)) {
      throw new Error("Clean-install data ownership is unproven");
    }
    const directory = path.join(dataRoot, name);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== uid || info.gid !== gid ||
        (info.mode & 0o777) !== 0o700 || await realpath(directory) !== directory ||
        JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(children)) {
      throw new Error("Installed clean-install data directory is untrusted");
    }
  }
  const tmux = path.join(dataRoot, NAMES[0], "tmux");
  const info = await lstat(tmux);
  if (!info.isDirectory() || info.uid !== work.uid || info.gid !== work.gid ||
      (info.mode & 0o777) !== 0o700 || await realpath(tmux) !== tmux ||
      (await readdir(tmux)).length !== 0) {
    throw new Error("Clean-install tmux directory is untrusted");
  }
  return { data: "private-owned", directories: 4 };
}

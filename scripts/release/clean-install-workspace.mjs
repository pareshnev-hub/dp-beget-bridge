import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const command = (binary, args) => exec(binary, args, { timeout: 5000, maxBuffer: 8192,
  env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" } });

export function validateBasicWorkspaceAcl(source, groupPermissions) {
  if (typeof source !== "string" || source.trim() !==
      `user::rwx\ngroup::${groupPermissions}\nother::---`) {
    throw new Error("Clean workspace requires basic private permissions without extended/default ACLs");
  }
}

async function workIdentity(plan) {
  const user = (await command("getent", ["passwd", plan.workUser])).stdout.trim().split(":");
  const group = (await command("getent", ["group", plan.workGroup])).stdout.trim().split(":");
  const uid = Number(user[2]), gid = Number(group[2]);
  if (user.length !== 7 || group.length !== 4 || user[0] !== plan.workUser || group[0] !== plan.workGroup ||
      !Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(gid) || gid < 1 || Number(user[3]) !== gid) {
    throw new Error("Clean workspace work identity is unproven");
  }
  return { uid, gid };
}

async function directory(plan) {
  const target = plan?.allowedRoot;
  if (typeof target !== "string" || !path.isAbsolute(target) || path.normalize(target) !== target || target === "/") {
    throw new Error("Invalid clean workspace path");
  }
  const parent = path.dirname(target), info = await lstat(parent);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0 || await realpath(parent) !== parent ||
      await realpath(target) !== target) throw new Error("Clean workspace requires a protected root-owned parent");
  return open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

async function sameTarget(handle, target) {
  const [held, current] = await Promise.all([handle.stat(), lstat(target)]);
  if (!held.isDirectory() || !current.isDirectory() || held.dev !== current.dev || held.ino !== current.ino ||
      await realpath(target) !== target) throw new Error("Clean workspace directory changed");
  return held;
}

async function acl(handle, groupPermissions) {
  const source = (await command("getfacl", ["--omit-header", "--absolute-names", "--numeric", "--", `/proc/${process.pid}/fd/${handle.fd}`])).stdout;
  validateBasicWorkspaceAcl(source, groupPermissions);
}

export async function inspectCleanWorkspace({ identityPlan, identities } = {}) {
  const work = await workIdentity(identityPlan), handle = await directory(identityPlan);
  try {
    const info = await sameTarget(handle, identityPlan.allowedRoot);
    if (identities?.identities !== "journal-bound" || !Number.isSafeInteger(identities.ipcGid) || identities.ipcGid < 1 ||
        info.uid !== work.uid || info.gid !== identities.ipcGid || (info.mode & 0o7777) !== 0o2770) {
      throw new Error("Clean workspace is not shared privately with the bound IPC group");
    }
    await acl(handle, "rwx");
    const after = await sameTarget(handle, identityPlan.allowedRoot);
    if (after.uid !== info.uid || after.gid !== info.gid || after.mode !== info.mode) throw new Error("Clean workspace permissions changed");
    return { workspace: "shared-private" };
  } finally { await handle.close(); }
}

// Called only inside the retained config-install transaction. Change the
// selected directory through its held descriptor, never descendants or the
// work account. Partial mutation keeps the config lock for deliberate recovery.
export async function configureCleanWorkspace({ identityPlan, identities } = {}) {
  if (process.getuid?.() !== 0 || process.platform !== "linux") throw new Error("Root Linux workspace installation required");
  const work = await workIdentity(identityPlan), handle = await directory(identityPlan);
  try {
    const info = await sameTarget(handle, identityPlan.allowedRoot), mode = info.mode & 0o7777;
    if (identities?.identities !== "journal-bound" || !Number.isSafeInteger(identities.ipcGid) || identities.ipcGid < 1 ||
        info.uid !== work.uid || info.gid !== work.gid || ![0o700, 0o770].includes(mode)) {
      throw new Error("Clean workspace original owner/group/private permissions are unproven");
    }
    await acl(handle, mode === 0o700 ? "---" : "rwx");
    await sameTarget(handle, identityPlan.allowedRoot);
    await handle.chown(-1, identities.ipcGid);
    await handle.chmod(0o2770);
    await handle.sync();
    await inspectCleanWorkspace({ identityPlan, identities });
  } finally { await handle.close(); }
}

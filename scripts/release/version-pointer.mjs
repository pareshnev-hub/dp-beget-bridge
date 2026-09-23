import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readlink, realpath, rename, rmdir, symlink, unlink } from "node:fs/promises";
import path from "node:path";

const VERSION_DIR = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?)-([0-9a-f]{40})$/;

async function releaseDirectory(root, name) {
  const match = VERSION_DIR.exec(name);
  if (!match) throw new Error("Invalid prepared release directory name");
  const directory = path.join(root, "releases", name);
  const info = await lstat(directory);
  if (!info.isDirectory() || (await realpath(directory)) !== directory) {
    throw new Error("Prepared release is not a real directory");
  }
  const packagePath = path.join(directory, "package.json");
  if (!(await lstat(packagePath)).isFile()) throw new Error("Prepared release has no regular package metadata");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  if (pkg.name !== "dp-beget-bridge" || pkg.version !== match[1]) {
    throw new Error("Prepared release version does not match its package");
  }
  return `releases/${name}`;
}

async function managedLink(root, linkName) {
  const filename = path.join(root, linkName);
  let info;
  try { info = await lstat(filename); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!info.isSymbolicLink()) throw new Error(`${linkName} must be a managed symlink`);
  const target = await readlink(filename);
  if (!target.startsWith("releases/")) throw new Error(`${linkName} points outside releases`);
  if (await releaseDirectory(root, target.slice("releases/".length)) !== target) {
    throw new Error(`${linkName} has an invalid target`);
  }
  return target;
}

async function syncDirectory(root) {
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicLink(root, linkName, target, sync = syncDirectory) {
  const temporary = path.join(root, `.next-${linkName}-${randomUUID()}`);
  await symlink(target, temporary);
  try {
    await sync(root);
    await rename(temporary, path.join(root, linkName));
    await sync(root);
  } finally {
    try { await unlink(temporary); await sync(root); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export async function switchVersion({ releaseRoot, versionDir, checkHealthy, sync = syncDirectory }) {
  if (!path.isAbsolute(releaseRoot || "") || typeof checkHealthy !== "function") {
    throw new Error("An absolute release root and health callback are required");
  }
  const root = path.resolve(releaseRoot);
  if ((await realpath(root)) !== root || (await realpath(path.join(root, "releases"))) !== path.join(root, "releases")) {
    throw new Error("Release root and releases directory cannot be symlinks");
  }
  const lock = path.join(root, ".activation.lock");
  await mkdir(lock, { mode: 0o700 });
  let retainLock = false;
  try {
    await sync(root);
    const next = await releaseDirectory(root, versionDir);
    const current = await managedLink(root, "current");
    await managedLink(root, "previous");
    if (current === next) throw new Error("Release is already active");
    let mutationStarted = false;
    try {
      mutationStarted = true;
      await atomicLink(root, "current", next, sync);
      await checkHealthy({ current: next, previous: current });
      if (current) await atomicLink(root, "previous", current, sync);
      return { current: next, previous: current };
    } catch (error) {
      if (mutationStarted) {
        try {
          const active = await managedLink(root, "current");
          if (active === next) {
            if (current) await atomicLink(root, "current", current, sync);
            else { await unlink(path.join(root, "current")); await sync(root); }
          } else if (active !== current) throw new Error("Current release pointer is neither old nor candidate");
        } catch (rollbackError) {
          retainLock = true;
          throw new AggregateError([error, rollbackError], "Activation and pointer rollback failed");
        }
      }
      throw error;
    }
  } finally {
    if (!retainLock) { await rmdir(lock); await sync(root); }
  }
}

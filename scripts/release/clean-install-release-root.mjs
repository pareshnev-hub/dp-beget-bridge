import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { advanceCleanInstallJournal, readCleanInstallJournal } from "./clean-install-journal.mjs";

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function parentOf(releaseRoot) {
  if (typeof releaseRoot !== "string" || !path.isAbsolute(releaseRoot) ||
      path.normalize(releaseRoot) !== releaseRoot || releaseRoot === "/") {
    throw new Error("Absolute version root is required");
  }
  const parent = path.dirname(releaseRoot);
  const info = await stat(parent);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
      await realpath(parent) !== parent) throw new Error("Untrusted version-root parent");
  return parent;
}

export async function inspectCleanReleaseRootTarget({ releaseRoot } = {}) {
  await parentOf(releaseRoot);
  try { await lstat(releaseRoot); throw new Error("Clean-install version root already exists"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return { releaseRoot: "unoccupied" };
}

export async function inspectCreatedCleanReleaseRoot({ releaseRoot } = {}) {
  await parentOf(releaseRoot);
  for (const directory of [releaseRoot, path.join(releaseRoot, "releases")]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== 0 || info.gid !== 0 ||
        (info.mode & 0o777) !== 0o755 || await realpath(directory) !== directory) {
      throw new Error("Clean-install version root is untrusted");
    }
  }
  if (JSON.stringify((await readdir(releaseRoot)).sort()) !== '["releases"]' ||
      (await readdir(path.join(releaseRoot, "releases"))).length !== 0) {
    throw new Error("Clean-install version root has unexpected contents");
  }
  return { releaseRoot: "private-empty" };
}

// The empty root and releases directory are inert until signed promotion.
// A partial mkdir keeps the journal lock for deliberate recovery.
export async function installCleanReleaseRoot({ journalPath, trustDir,
  configDir = "/etc/dp-beget-bridge", unitDirectory = "/etc/systemd/system",
  dataRoot = "/var/lib", inspectTarget = inspectCleanReleaseRootTarget,
  advance = advanceCleanInstallJournal } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to create a clean version root");
  const journal = await readCleanInstallJournal(journalPath);
  if (journal.phase !== "release-root-intent") {
    throw new Error("Version root creation requires journaled intent");
  }
  const releaseRoot = journal.releaseRoot;
  const parent = await parentOf(releaseRoot);
  if ((await inspectTarget({ releaseRoot }))?.releaseRoot !== "unoccupied") {
    throw new Error("Clean-install version root is occupied");
  }
  const journalParent = path.dirname(journalPath);
  const lock = `${journalPath}.release-root-install.lock`;
  const handle = await open(lock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${journal.transactionId}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(journalParent);
  let mutationStarted = false;
  try {
    if ((await inspectTarget({ releaseRoot }))?.releaseRoot !== "unoccupied") {
      throw new Error("Clean-install version root changed");
    }
    mutationStarted = true;
    await mkdir(releaseRoot, { mode: 0o755 });
    const releases = path.join(releaseRoot, "releases");
    await mkdir(releases, { mode: 0o755 });
    await chmod(releases, 0o755);
    await chmod(releaseRoot, 0o755);
    await syncDirectory(releases);
    await syncDirectory(releaseRoot);
    await syncDirectory(parent);
    const next = await advance({ journalPath, transactionId: journal.transactionId,
      expectedPhase: "release-root-intent", nextPhase: "release-root-ready",
      configDir, unitDirectory, dataRoot, trustDir });
    await unlink(lock);
    await syncDirectory(journalParent);
    return { transactionId: next.transactionId, phase: next.phase,
      releaseRoot: "private-empty" };
  } catch (error) {
    if (!mutationStarted) {
      await unlink(lock).catch(() => {});
      await syncDirectory(journalParent);
    }
    throw error;
  }
}

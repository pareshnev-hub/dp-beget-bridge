import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

function normalizedAbsolute(filename) {
  return typeof filename === "string" && path.isAbsolute(filename) &&
    path.normalize(filename) === filename && filename !== "/";
}

function overlaps(first, second) {
  return first === second || first.startsWith(`${second}${path.sep}`) ||
    second.startsWith(`${first}${path.sep}`);
}

async function realDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || (await realpath(directory)) !== directory ||
      (info.mode & 0o022) !== 0) throw new Error(`Untrusted recovery destination directory: ${directory}`);
  return info;
}

async function realFile(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink !== 1 || (await realpath(filename)) !== filename) {
    throw new Error(`Untrusted recovery destination file: ${filename}`);
  }
  return info;
}

async function matchingConfigTree(live, staged) {
  const liveEntries = (await readdir(live)).sort();
  const stagedEntries = (await readdir(staged)).sort();
  if (JSON.stringify(liveEntries) !== JSON.stringify(stagedEntries)) {
    throw new Error("Live configuration inventory differs from staged recovery");
  }
  for (const name of liveEntries) {
    const current = path.join(live, name);
    const restored = path.join(staged, name);
    const stagedInfo = await lstat(restored);
    if (stagedInfo.isDirectory()) {
      await realDirectory(restored);
      const liveInfo = await realDirectory(current);
      if (liveInfo.uid !== stagedInfo.uid || liveInfo.gid !== stagedInfo.gid ||
          (liveInfo.mode & 0o777) !== (stagedInfo.mode & 0o777)) {
        throw new Error(`Configuration directory ownership changed: ${current}`);
      }
      await matchingConfigTree(current, restored);
    } else if (stagedInfo.isFile()) {
      await realFile(restored);
      const liveInfo = await realFile(current);
      if (liveInfo.uid !== stagedInfo.uid || liveInfo.gid !== stagedInfo.gid ||
          (liveInfo.mode & 0o777) !== (stagedInfo.mode & 0o777)) {
        throw new Error(`Configuration file ownership changed: ${current}`);
      }
    } else throw new Error("Staged configuration contains a special entry");
  }
}

// Read-only topology check. Its result is evidence for a later journaled
// replacement, which must recheck every inode and all closed-ingress boundaries.
export async function inspectRecoveryDestinations({ stagedDirectory, sources, databases } = {}) {
  if (process.getuid?.() !== 0 || !normalizedAbsolute(stagedDirectory) ||
      !normalizedAbsolute(sources?.configRoot) || !Array.isArray(sources.databases) ||
      !Array.isArray(databases) || sources.databases.length !== databases.length ||
      databases.length === 0) throw new Error("Root and exact staged recovery sources are required");
  const locations = [sources.configRoot, ...sources.databases.map(item => item?.path)];
  if (locations.some(filename => !normalizedAbsolute(filename) || overlaps(filename, stagedDirectory)) ||
      locations.some((filename, index) => locations.slice(index + 1).some(other => overlaps(filename, other))) ||
      new Set(databases).size !== databases.length ||
      sources.databases.some((item, index) => item?.name !== databases[index] ||
        !/^[a-z][a-z0-9_-]{0,31}$/.test(item.name))) {
    throw new Error("Overlapping or invalid recovery destinations");
  }
  const staged = await realDirectory(stagedDirectory);
  if (staged.uid !== 0 || (staged.mode & 0o077) !== 0) {
    throw new Error("Staged recovery directory must be root-owned and private");
  }
  const config = await realDirectory(sources.configRoot);
  const stagedConfig = await realDirectory(path.join(stagedDirectory, "config"));
  if (config.uid !== stagedConfig.uid || config.gid !== stagedConfig.gid ||
      (config.mode & 0o777) !== (stagedConfig.mode & 0o777)) {
    throw new Error("Configuration root ownership changed");
  }
  await matchingConfigTree(sources.configRoot, path.join(stagedDirectory, "config"));
  const files = [];
  for (const item of sources.databases) {
    const parent = await realDirectory(path.dirname(item.path));
    const current = await realFile(item.path);
    const restored = await realFile(path.join(stagedDirectory, "sqlite", `${item.name}.sqlite`));
    if (parent.uid !== current.uid || current.uid !== restored.uid ||
        current.gid !== restored.gid || (current.mode & 0o777) !== (restored.mode & 0o777)) {
      throw new Error(`SQLite destination ownership or mode changed: ${item.name}`);
    }
    for (const sidecar of [`${item.path}-wal`, `${item.path}-shm`, `${item.path}-journal`]) {
      try { await lstat(sidecar); throw new Error(`SQLite sidecar needs explicit recovery: ${item.name}`); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    files.push({ name: item.name, path: item.path, dev: current.dev, ino: current.ino,
      uid: current.uid, gid: current.gid, mode: current.mode & 0o777 });
  }
  return { configRoot: sources.configRoot, configDev: config.dev, configIno: config.ino,
    databases: files };
}

import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const VERSION = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?)-([0-9a-f]{40})$/;

export async function inspectLocalRelease(root) {
  if (!path.isAbsolute(root || "") || path.resolve(root) !== root ||
      await fs.realpath(root) !== root || !(await fs.lstat(root)).isDirectory()) {
    throw new Error("Invalid installed release directory");
  }
  let link;
  try { link = await fs.lstat(path.join(root, "current")); }
  catch (error) {
    if (error.code === "ENOENT") return { mode: "legacy" };
    throw error;
  }
  if (!link.isSymbolicLink()) throw new Error("Invalid managed release pointer");
  const target = await fs.readlink(path.join(root, "current"));
  if (!target.startsWith("releases/")) throw new Error("Invalid managed release pointer");
  const match = target.slice("releases/".length).match(VERSION);
  if (!match || await fs.realpath(path.join(root, "current")) !== path.join(root, target)) {
    throw new Error("Invalid managed release identity");
  }
  const manifest = await fs.open(path.join(root, "current", "package.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await manifest.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024) {
      throw new Error("Invalid installed package metadata");
    }
    const pkg = JSON.parse(await manifest.readFile({ encoding: "utf8" }));
    if (pkg.name !== "dp-beget-bridge" || pkg.version !== match[1]) {
      throw new Error("Installed package version does not match its release pointer");
    }
    return { mode: "managed", version: match[1], commit: match[2] };
  } finally { await manifest.close(); }
}

export async function inspectLocalState(databasePath) {
  if (!path.isAbsolute(databasePath || "") || path.resolve(databasePath) !== databasePath ||
      await fs.realpath(databasePath) !== databasePath) {
    throw new Error("Invalid local state database path");
  }
  const info = await fs.lstat(databasePath);
  if (!info.isFile() || info.nlink !== 1) throw new Error("Unsafe local state database");
  const database = new DatabaseSync(databasePath, { openReadOnly: true });
  try {
    const schema = database.prepare("PRAGMA user_version").get().user_version;
    if (schema !== 2) throw new Error("Unsupported local state schema");
    return { schema };
  } finally { database.close(); }
}

export async function inspectLocalDisk(directory, minimumFree = 256 * 1024 * 1024) {
  if (!path.isAbsolute(directory || "") || !Number.isSafeInteger(minimumFree) || minimumFree < 1) {
    throw new Error("Invalid disk reserve parameters");
  }
  const free = await fs.statfs(directory, { bigint: true });
  if (free.bavail < 0n || free.bsize < 1n ||
      free.bavail * free.bsize < BigInt(minimumFree)) {
    throw Object.assign(new Error("Local disk reserve is low"), { code: "LOW_DISK" });
  }
  return { reserve: "ok" };
}

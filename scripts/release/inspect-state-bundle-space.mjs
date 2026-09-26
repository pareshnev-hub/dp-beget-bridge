import { lstat, statfs } from "node:fs/promises";
import path from "node:path";

const MAX_CONFIG_BYTES = 16n * 1024n * 1024n; // backup-config.mjs ceiling
const MIN_FREE_AFTER = 512n * 1024n * 1024n;
const COPIES = 4n; // snapshot, staged recovery and destination-local copies

// Root read-only capacity check before the grouped bundle creates a path.
// This reserves space for existing DB and journal bytes copied through recovery, the
// maximum accepted config tree and free space after those copies. A separate
// release-artifact budget is required before candidate promotion.
export async function inspectStateBundleSpace({ databases, parent,
  inspectFile = lstat, inspectFilesystem = statfs } = {}) {
  if (!path.isAbsolute(parent || "") || !Array.isArray(databases) ||
      databases.length === 0) throw new Error("State bundle space inputs are incomplete");
  let databaseBytes = 0n;
  let journalBytes = 0n;
  async function sizeRegular(filename, optional) {
    let info;
    try { info = await inspectFile(filename); }
    catch (error) {
      if (optional && error.code === "ENOENT") return 0n;
      throw error;
    }
    if (!info.isFile() || info.nlink !== 1 || !Number.isSafeInteger(info.size) || info.size < 0) {
      throw new Error("State bundle SQLite source or sidecar cannot be sized safely");
    }
    return BigInt(info.size);
  }
  for (const database of databases) {
    if (!path.isAbsolute(database?.source || "")) {
      throw new Error("State bundle database source is not absolute");
    }
    databaseBytes += await sizeRegular(database.source, false);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      journalBytes += await sizeRegular(`${database.source}${suffix}`, true);
    }
  }
  const volume = await inspectFilesystem(parent, { bigint: true });
  if (typeof volume.bavail !== "bigint" || typeof volume.bsize !== "bigint" ||
      volume.bavail < 0n || volume.bsize <= 0n) {
    throw new Error("State bundle filesystem capacity is unavailable");
  }
  const availableBytes = volume.bavail * volume.bsize;
  const requiredBytes = COPIES * (databaseBytes + journalBytes + MAX_CONFIG_BYTES) + MIN_FREE_AFTER;
  if (availableBytes < requiredBytes) {
    throw new Error("Insufficient free space for grouped migration snapshot and recovery copies");
  }
  return { availableBytes, requiredBytes, databaseBytes, journalBytes,
    scope: "state bundle and recovery copies only; candidate artifact excluded" };
}

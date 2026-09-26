import { statfs } from "node:fs/promises";
import path from "node:path";

const MAX_COMPRESSED = 64n * 1024n * 1024n; // extract-verified-artifact.mjs
const MAX_EXPANDED = 256n * 1024n * 1024n;
const DEPENDENCY_ALLOWANCE = 1024n * 1024n * 1024n;
const CACHE_ALLOWANCE = 1024n * 1024n * 1024n;
const MIN_FREE_AFTER = 512n * 1024n * 1024n;

// Capacity guard before creating the private workspace. npm's installed tree
// and cache have an allowance, not an enforced size ceiling; the full release
// still needs a measured rehearsal and sufficient room for state snapshots.
export async function inspectReleasePreparationSpace({ parent, archiveBytes,
  inspectFilesystem = statfs } = {}) {
  if (!path.isAbsolute(parent || "") || !Number.isSafeInteger(archiveBytes) || archiveBytes < 1 ||
      BigInt(archiveBytes) > MAX_COMPRESSED) {
    throw new Error("Release preparation capacity inputs are invalid or archive exceeds extraction ceiling");
  }
  const volume = await inspectFilesystem(parent, { bigint: true });
  if (typeof volume.bavail !== "bigint" || typeof volume.bsize !== "bigint" ||
      volume.bavail < 0n || volume.bsize <= 0n) {
    throw new Error("Release preparation filesystem capacity is unavailable");
  }
  const availableBytes = volume.bavail * volume.bsize;
  const requiredBytes = BigInt(archiveBytes) + MAX_EXPANDED + DEPENDENCY_ALLOWANCE +
    CACHE_ALLOWANCE + MIN_FREE_AFTER;
  if (availableBytes < requiredBytes) {
    throw new Error("Insufficient free space to prepare the release candidate");
  }
  return { availableBytes, requiredBytes,
    scope: "staged archive, bounded extraction, estimated npm dependency/cache space and 512 MiB free; state snapshots excluded" };
}

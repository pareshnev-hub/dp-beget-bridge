import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { readRegularFile } from "./verify-artifact.mjs";
import { verifySystemdUnitBackup } from "./verify-systemd-unit-backup.mjs";

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function restoreSystemdUnitBackup({ backupDir, outputDir, expectedManifestSha256 } = {}) {
  if (process.getuid?.() !== 0 || !path.isAbsolute(backupDir || "") ||
      !path.isAbsolute(outputDir || "") || path.normalize(outputDir) !== outputDir ||
      !/^[0-9a-f]{64}$/.test(expectedManifestSha256 || "")) {
    throw new Error("Root, new absolute output path and bound unit backup digest are required");
  }
  const parent = path.dirname(outputDir);
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.uid !== 0 || (parentInfo.mode & 0o022) !== 0 ||
      (await realpath(parent)) !== parent || outputDir === backupDir ||
      outputDir.startsWith(`${backupDir}${path.sep}`) || backupDir.startsWith(`${outputDir}${path.sep}`)) {
    throw new Error("Unit recovery staging requires a separate trusted root-owned parent");
  }
  const initial = await verifySystemdUnitBackup({ backupDir });
  if (initial.manifestSha256 !== expectedManifestSha256) {
    throw new Error("Unit backup no longer matches the migration journal");
  }
  const manifestBytes = await readRegularFile(path.join(backupDir, "backup-manifest.json"), 64 * 1024);
  if (createHash("sha256").update(manifestBytes).digest("hex") !== expectedManifestSha256) {
    throw new Error("Unit backup changed before recovery staging");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  await mkdir(outputDir, { mode: 0o700 });
  try {
    const directories = new Set([outputDir]);
    for (const item of manifest.files) {
      if (!Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777 ||
          !Number.isSafeInteger(item.gid) || item.gid < 0) throw new Error("Invalid original unit ownership");
      const source = path.join(backupDir, "files", item.path);
      const content = await readRegularFile(source, 64 * 1024);
      if (content.length !== item.size ||
          createHash("sha256").update(content).digest("hex") !== item.sha256) {
        throw new Error("Original unit changed during recovery staging");
      }
      const target = path.join(outputDir, item.path);
      const directory = path.dirname(target);
      if (directory !== outputDir) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        directories.add(directory);
      }
      const handle = await open(target,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
      if (item.gid !== 0) await chown(target, 0, item.gid);
      await chmod(target, item.mode);
      const synced = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await synced.sync(); } finally { await synced.close(); }
      const staged = await lstat(target);
      if (!staged.isFile() || staged.nlink !== 1 || staged.uid !== 0 || staged.gid !== item.gid ||
          (staged.mode & 0o777) !== item.mode ||
          createHash("sha256").update(await readRegularFile(target, 64 * 1024)).digest("hex") !== item.sha256) {
        throw new Error("Staged original unit failed verification");
      }
    }
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) await syncDirectory(directory);
    const after = await verifySystemdUnitBackup({ backupDir });
    if (after.manifestSha256 !== expectedManifestSha256) {
      throw new Error("Unit backup changed during recovery staging");
    }
    await syncDirectory(parent);
    return { directory: outputDir, files: manifest.files.length, manifestSha256: expectedManifestSha256 };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

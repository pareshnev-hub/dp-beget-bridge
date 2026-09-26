import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { readMigrationJournal } from "./migration-journal.mjs";
import { verifyStagedRecoveryPair } from "./verify-staged-recovery-pair.mjs";
import { readRegularFile } from "./verify-artifact.mjs";

const FORMAT = "dp-beget-bridge-pre-exposure-rollback-v1";
const SHA = /^[0-9a-f]{64}$/;

async function trustedParent(filename) {
  if (!path.isAbsolute(filename || "") || path.normalize(filename) !== filename) {
    throw new Error("Rollback intent requires a normalized absolute path");
  }
  const parent = path.dirname(filename);
  const info = await lstat(parent);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
      (await realpath(parent)) !== parent) throw new Error("Untrusted rollback intent parent");
  return parent;
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

function validIntent(record) {
  if (!record || Object.keys(record).sort().join(",") !==
        "bundleManifestSha256,createdAt,destinations,format,journalPath,migrationPhase,migrationTransactionId,phase,stagedDev,stagedDirectory,stagedIno,unitManifestSha256" ||
      record.format !== FORMAT || record.phase !== "prepared" ||
      !/^[0-9a-f-]{36}$/.test(record.migrationTransactionId || "") ||
      !["snapshotted", "switched", "locally-healthy"].includes(record.migrationPhase) ||
      !SHA.test(record.bundleManifestSha256 || "") || !SHA.test(record.unitManifestSha256 || "") ||
      !path.isAbsolute(record.journalPath || "") ||
      !path.isAbsolute(record.stagedDirectory || "") ||
      path.normalize(record.journalPath) !== record.journalPath ||
      path.normalize(record.stagedDirectory) !== record.stagedDirectory ||
      !Number.isSafeInteger(record.stagedDev) || !Number.isSafeInteger(record.stagedIno) ||
      !record.destinations || !Array.isArray(record.destinations.databases) ||
      record.destinations.databases.length === 0 ||
      typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new Error("Invalid prepared rollback intent");
  }
  return record;
}

export async function readPreparedRollbackIntent(planPath) {
  await trustedParent(planPath);
  const info = await lstat(planPath);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o077) !== 0 ||
      info.size > 16 * 1024 || (await realpath(planPath)) !== planPath) {
    throw new Error("Untrusted prepared rollback intent");
  }
  return validIntent(JSON.parse((await readRegularFile(planPath, 16 * 1024)).toString("utf8")));
}

// Durable intent records an exact migration and current live inode identities.
// It makes no live state or unit change. A later controller must use its own
// crash-recoverable per-file journal before replacing anything.
export async function preparePreExposureRollback({ journalPath, stagedDirectory, planPath,
  ...boundary } = {}) {
  if (process.getuid?.() !== 0 || !path.isAbsolute(stagedDirectory || "") ||
      path.normalize(stagedDirectory) !== stagedDirectory ||
      typeof boundary.assertRouteExclusive !== "function") {
    throw new Error("Root, staged pair and exclusive route proof are required");
  }
  const parent = await trustedParent(planPath);
  if (planPath === stagedDirectory || planPath.startsWith(`${stagedDirectory}${path.sep}`)) {
    throw new Error("Rollback intent must be outside the staged recovery pair");
  }
  const journal = await readMigrationJournal(journalPath);
  if ([journal.snapshotPath, journal.unitBackup.path].some(directory =>
    planPath === directory || planPath.startsWith(`${directory}${path.sep}`))) {
    throw new Error("Rollback intent must be outside both migration backups");
  }
  const staged = await verifyStagedRecoveryPair({ ...boundary, journalPath, outputDir: stagedDirectory });
  if (staged.transactionId !== journal.transactionId || staged.phase !== journal.phase) {
    throw new Error("Migration changed before rollback intent");
  }
  const info = await lstat(stagedDirectory);
  const intent = validIntent({ format: FORMAT, phase: "prepared", createdAt: new Date().toISOString(),
    journalPath, migrationTransactionId: journal.transactionId, migrationPhase: journal.phase,
    bundleManifestSha256: journal.snapshotSha256,
    unitManifestSha256: journal.unitBackup.manifestSha256,
    stagedDirectory, stagedDev: info.dev, stagedIno: info.ino,
    destinations: staged.destinations });
  const handle = await open(planPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(intent) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(parent);
  return readPreparedRollbackIntent(planPath);
}

export async function verifyPreparedRollbackIntent({ planPath, ...boundary } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to verify rollback intent");
  const intent = await readPreparedRollbackIntent(planPath);
  const journal = await readMigrationJournal(intent.journalPath);
  if (journal.transactionId !== intent.migrationTransactionId ||
      journal.phase !== intent.migrationPhase ||
      journal.snapshotSha256 !== intent.bundleManifestSha256 ||
      journal.unitBackup.manifestSha256 !== intent.unitManifestSha256) {
    throw new Error("Migration changed since rollback intent");
  }
  const stagedInfo = await lstat(intent.stagedDirectory);
  if (stagedInfo.dev !== intent.stagedDev || stagedInfo.ino !== intent.stagedIno) {
    throw new Error("Staged pair was replaced since rollback intent");
  }
  const current = await verifyStagedRecoveryPair({ ...boundary,
    journalPath: intent.journalPath, outputDir: intent.stagedDirectory });
  if (JSON.stringify(current.destinations) !== JSON.stringify(intent.destinations)) {
    throw new Error("Live recovery destinations changed since rollback intent");
  }
  const again = await readPreparedRollbackIntent(planPath);
  if (JSON.stringify(again) !== JSON.stringify(intent)) throw new Error("Rollback intent changed during verification");
  return intent;
}

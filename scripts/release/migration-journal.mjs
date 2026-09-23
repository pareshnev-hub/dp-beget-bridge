import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { verifySystemdUnitBackup } from "./verify-systemd-unit-backup.mjs";
import { inspectLegacyServiceActivity, validateLegacyServiceActivity } from "./legacy-service-activity.mjs";

const PHASES = Object.freeze(["prepared", "guarded", "ingress-closed", "quiesced",
  "snapshotted", "switched", "locally-healthy", "ingress-open", "completed"]);
const SHA256 = /^[0-9a-f]{64}$/;

async function trustedParent(filename) {
  if (!path.isAbsolute(filename) || path.normalize(filename) !== filename) {
    throw new Error("Journal path must be normalized and absolute");
  }
  const parent = path.dirname(filename);
  const info = await stat(parent);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
      (await realpath(parent)) !== parent) throw new Error("Journal parent is not a trusted root directory");
  return parent;
}

async function syncDir(parent) {
  const handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

function validate(record) {
  if (!record || record.format !== "dp-beget-migration-journal-v3" ||
      Object.keys(record).sort().join(",") !==
        "artifactSha256,format,newCommit,oldCommit,phase,serviceActivity,snapshotPath,transactionId,unitBackup" ||
      !PHASES.includes(record.phase) || !/^[0-9a-f-]{36}$/.test(record.transactionId) ||
      !SHA256.test(record.artifactSha256) || typeof record.oldCommit !== "string" ||
      !/^[0-9a-f]{40}$/.test(record.oldCommit) ||
      !/^[0-9a-f]{40}$/.test(record.newCommit) ||
      typeof record.snapshotPath !== "string" ||
      (record.snapshotPath && !path.isAbsolute(record.snapshotPath)) ||
      !record.unitBackup || Object.keys(record.unitBackup).sort().join(",") !== "manifestSha256,path" ||
      typeof record.unitBackup.path !== "string" || !path.isAbsolute(record.unitBackup.path) ||
      path.normalize(record.unitBackup.path) !== record.unitBackup.path ||
      !SHA256.test(record.unitBackup.manifestSha256)) {
    throw new Error("Invalid migration journal");
  }
  validateLegacyServiceActivity(record.serviceActivity);
  return record;
}

export async function readMigrationJournal(filename) {
  await trustedParent(filename);
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o077) !== 0 ||
      info.size > 16 * 1024 || (await realpath(filename)) !== filename) {
    throw new Error("Untrusted migration journal");
  }
  return validate(JSON.parse(await readFile(filename, "utf8")));
}

export async function startMigrationJournal(filename, { oldCommit, newCommit, artifactSha256, unitBackupDir,
  inspectServices = inspectLegacyServiceActivity }) {
  if (process.getuid?.() !== 0) throw new Error("Root is required for a migration journal");
  const parent = await trustedParent(filename);
  const evidence = await verifySystemdUnitBackup({ backupDir: unitBackupDir });
  const serviceActivity = validateLegacyServiceActivity(await inspectServices());
  const record = validate({ format: "dp-beget-migration-journal-v3", transactionId: randomUUID(),
    phase: "prepared", oldCommit, newCommit, artifactSha256, snapshotPath: "",
    unitBackup: { path: unitBackupDir, manifestSha256: evidence.manifestSha256 }, serviceActivity });
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await syncDir(parent);
  return record;
}

export async function verifyJournalUnitBackup(record) {
  validate(record);
  const evidence = await verifySystemdUnitBackup({ backupDir: record.unitBackup.path });
  if (evidence.manifestSha256 !== record.unitBackup.manifestSha256) {
    throw new Error("Migration unit backup no longer matches the journal");
  }
  return evidence;
}

export async function advanceMigrationJournal(filename, expectedPhase, nextPhase, details = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required for a migration journal");
  const parent = await trustedParent(filename);
  const lock = `${filename}.lock`;
  const lockHandle = await open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await lockHandle.writeFile("migration transition in progress\n"); await lockHandle.sync(); }
  finally { await lockHandle.close(); }
  await syncDir(parent);
  let next;
  try {
    const previous = await readMigrationJournal(filename);
    if (previous.phase !== expectedPhase || PHASES.indexOf(nextPhase) !== PHASES.indexOf(expectedPhase) + 1 ||
        Object.keys(details).some(key => key !== "snapshotPath") ||
        (details.snapshotPath !== undefined && (!path.isAbsolute(details.snapshotPath) ||
          path.normalize(details.snapshotPath) !== details.snapshotPath))) {
      throw new Error("Migration journal phase transition rejected");
    }
    next = validate({ ...previous, ...details, phase: nextPhase });
    if (nextPhase === "snapshotted" && !next.snapshotPath) throw new Error("Snapshot path required");
  } catch (error) {
    await unlink(lock); await syncDir(parent);
    throw error;
  }
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify(next) + "\n"); await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temporary, filename); await syncDir(parent); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  await unlink(lock); await syncDir(parent);
  return next;
}

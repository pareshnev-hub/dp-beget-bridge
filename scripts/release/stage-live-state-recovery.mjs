import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, copyFile, lstat, open, readdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { restoreConfig } from "./restore-backup.mjs";
import { readMigrationJournal } from "./migration-journal.mjs";
import { readPreparedRollbackIntent } from "./prepare-pre-exposure-rollback.mjs";
import { readOriginalUnitViewRecord } from "./restore-original-unit-view.mjs";
import { readRegularFile } from "./verify-artifact.mjs";
import { verifyOriginalUnitViewRestored } from "./verify-original-unit-view.mjs";

const FORMAT = "dp-beget-bridge-live-state-copies-v1";
const SHA = /^[0-9a-f]{64}$/;

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function syncTree(directory) {
  for (const name of await readdir(directory)) {
    const target = path.join(directory, name);
    const info = await lstat(target);
    if (info.isDirectory()) await syncTree(target);
    else if (info.isFile() && info.nlink === 1) {
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
    } else throw new Error("Prepared configuration contains a link or special entry");
  }
  await syncDirectory(directory);
}
async function digestFile(filename) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (await realpath(filename)) !== filename) {
      throw new Error("Recovery copy is not a real regular file");
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    return { uid: info.uid, gid: info.gid, mode: info.mode, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}
async function compareTree(source, copy) {
  const left = await lstat(source);
  const right = await lstat(copy);
  if (!left.isDirectory() || !right.isDirectory() ||
      (await realpath(copy)) !== copy || left.uid !== right.uid || left.gid !== right.gid ||
      (left.mode & 0o777) !== (right.mode & 0o777)) {
    throw new Error("Prepared configuration directory changed");
  }
  const names = (await readdir(source)).sort();
  if (JSON.stringify(names) !== JSON.stringify((await readdir(copy)).sort())) {
    throw new Error("Prepared configuration inventory changed");
  }
  for (const name of names) {
    const original = path.join(source, name);
    const target = path.join(copy, name);
    const info = await lstat(original);
    if (info.isDirectory()) await compareTree(original, target);
    else if (info.isFile()) {
      const a = await digestFile(original);
      const b = await digestFile(target);
      if (a.sha256 !== b.sha256 || a.uid !== b.uid || a.gid !== b.gid ||
          (a.mode & 0o777) !== (b.mode & 0o777)) {
        throw new Error("Prepared configuration file changed");
      }
    } else throw new Error("Staged configuration contains a special entry");
  }
}
async function trustedParent(filename, rootOwner = false) {
  if (!path.isAbsolute(filename || "") || path.normalize(filename) !== filename) {
    throw new Error("Live recovery copy requires a normalized absolute path");
  }
  const parent = path.dirname(filename);
  const info = await lstat(parent);
  if (!info.isDirectory() || (info.mode & 0o022) !== 0 ||
      (rootOwner && info.uid !== 0) || (await realpath(parent)) !== parent) {
    throw new Error("Untrusted live recovery copy parent");
  }
  return parent;
}
function validate(record) {
  if (!record || Object.keys(record).sort().join(",") !==
        "configCopy,databases,format,migrationTransactionId,phase,planPath,stopRecordPath,unitRecordPath,unitRecordSha256" ||
      record.format !== FORMAT || !["copying", "prepared"].includes(record.phase) ||
      !/^[0-9a-f-]{36}$/.test(record.migrationTransactionId || "") ||
      !SHA.test(record.unitRecordSha256 || "") ||
      ![record.planPath, record.stopRecordPath, record.unitRecordPath, record.configCopy].every(
        filename => path.isAbsolute(filename || "") && path.normalize(filename) === filename) ||
      !Array.isArray(record.databases) || record.databases.length === 0 ||
      record.databases.some(item => !item || Object.keys(item).sort().join(",") !==
        "copy,name,source" || !/^[a-z][a-z0-9_-]{0,31}$/.test(item.name || "") ||
        ![item.copy, item.source].every(filename =>
          path.isAbsolute(filename || "") && path.normalize(filename) === filename)) ||
      new Set([record.configCopy, ...record.databases.map(item => item.copy)]).size !==
        record.databases.length + 1) {
    throw new Error("Invalid live recovery copy record");
  }
  return record;
}
export async function readLiveStateCopyRecord(recordPath) {
  await trustedParent(recordPath, true);
  const info = await lstat(recordPath);
  if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 || info.size > 16 * 1024 ||
      (await realpath(recordPath)) !== recordPath) {
    throw new Error("Untrusted live recovery copy record");
  }
  return validate(JSON.parse((await readRegularFile(recordPath, 16 * 1024)).toString("utf8")));
}
async function verifyCopy(recordPath, record, proof) {
  const current = await verifyOriginalUnitViewRestored(proof);
  if (current.transactionId !== record.migrationTransactionId ||
      JSON.stringify(await readLiveStateCopyRecord(recordPath)) !== JSON.stringify(record) ||
      createHash("sha256").update(await readRegularFile(record.unitRecordPath, 4096)).digest("hex") !==
        record.unitRecordSha256 ||
      path.dirname(current.destinations.configRoot) !== path.dirname(record.configCopy)) {
    throw new Error("Live recovery copy record or boundary changed");
  }
  await trustedParent(record.configCopy);
  const staged = path.join(current.stagedDirectory, "state");
  await compareTree(path.join(staged, "config"), record.configCopy);
  for (const item of record.databases) {
    await trustedParent(item.copy);
    const live = current.destinations.databases.find(db => db.name === item.name);
    if (!live || live.path !== item.source || path.dirname(item.copy) !== path.dirname(item.source)) {
      throw new Error("Prepared database destination changed");
    }
    const source = path.join(staged, "sqlite", `${item.name}.sqlite`);
    const src = await digestFile(source);
    const dest = await digestFile(item.copy);
    if (dest.uid !== live.uid || dest.gid !== live.gid ||
        (dest.mode & 0o777) !== live.mode || src.sha256 !== dest.sha256) {
      throw new Error(`Prepared SQLite copy changed: ${item.name}`);
    }
  }
  return current;
}

export async function verifyPreparedLiveStateCopies({ recordPath, planPath, stopRecordPath,
  unitRecordPath, stateDatabase, ...boundary } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to verify live recovery copies");
  const record = await readLiveStateCopyRecord(recordPath);
  if (record.phase !== "prepared" || record.planPath !== planPath ||
      record.stopRecordPath !== stopRecordPath || record.unitRecordPath !== unitRecordPath) {
    throw new Error("Live recovery copies are incomplete or belong to another rollback");
  }
  await verifyCopy(recordPath, record, { ...boundary, planPath, stopRecordPath,
    unitRecordPath, stateDatabase });
  return record;
}

// Journal every destination-local copy before creating it. A crash or copy
// error leaves 'copying' and the ingress marker in place; no live data moves.
export async function stageLiveStateRecovery({ recordPath, planPath, stopRecordPath, unitRecordPath,
  stateDatabase, copyConfig = restoreConfig, copyDatabase = copyFile, ...boundary } = {}) {
  if (process.getuid?.() !== 0 || ![recordPath, planPath, stopRecordPath, unitRecordPath].every(
    filename => path.isAbsolute(filename || "") && path.normalize(filename) === filename) ||
      new Set([recordPath, planPath, stopRecordPath, unitRecordPath]).size !== 4) {
    throw new Error("Root and separate absolute live recovery records are required");
  }
  const proof = { ...boundary, planPath, stopRecordPath, unitRecordPath, stateDatabase };
  const initial = await verifyOriginalUnitViewRestored(proof);
  const intent = await readPreparedRollbackIntent(planPath);
  const journal = await readMigrationJournal(intent.journalPath);
  const original = await readOriginalUnitViewRecord(unitRecordPath);
  const protectedRoots = [initial.stagedDirectory, journal.snapshotPath, journal.unitBackup.path,
    boundary.unitDirectory || "/etc/systemd/system"];
  if (protectedRoots.some(directory => recordPath === directory ||
      recordPath.startsWith(`${directory}${path.sep}`))) {
    throw new Error("Live recovery copy record must be outside state and unit backups");
  }
  const parent = await trustedParent(recordPath, true);
  const suffix = randomUUID();
  const configCopy = `${initial.destinations.configRoot}.r0004-restore-${suffix}`;
  const databases = initial.destinations.databases.map(item => ({ name: item.name,
    source: item.path, copy: `${item.path}.r0004-restore-${suffix}` }));
  for (const filename of [configCopy, ...databases.map(item => item.copy)]) await trustedParent(filename);
  const record = validate({ format: FORMAT, phase: "copying",
    migrationTransactionId: initial.transactionId, planPath, stopRecordPath, unitRecordPath,
    unitRecordSha256: createHash("sha256").update(await readRegularFile(unitRecordPath, 4096)).digest("hex"),
    configCopy, databases });
  const handle = await open(recordPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(parent);
  await copyConfig({ backupDir: path.join(journal.snapshotPath, "config"), outputDir: configCopy });
  await syncTree(configCopy);
  await syncDirectory(path.dirname(configCopy));
  for (const item of databases) {
    const source = path.join(initial.stagedDirectory, "state", "sqlite", `${item.name}.sqlite`);
    await copyDatabase(source, item.copy, constants.COPYFILE_EXCL);
    const destination = initial.destinations.databases.find(db => db.name === item.name);
    await chown(item.copy, destination.uid, destination.gid);
    await chmod(item.copy, destination.mode);
    const copied = await open(item.copy, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await copied.sync(); } finally { await copied.close(); }
    await syncDirectory(path.dirname(item.copy));
  }
  await verifyCopy(recordPath, record, proof);
  const next = validate({ ...record, phase: "prepared" });
  const temporary = `${recordPath}.${randomUUID()}.tmp`;
  const updated = await open(temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await updated.writeFile(JSON.stringify(next) + "\n"); await updated.sync(); }
  finally { await updated.close(); }
  await rename(temporary, recordPath);
  await syncDirectory(parent);
  await verifyCopy(recordPath, next, proof);
  return next;
}

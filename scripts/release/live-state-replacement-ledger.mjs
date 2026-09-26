import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { readLiveStateCopyRecord, verifyPreparedLiveStateCopies } from "./stage-live-state-recovery.mjs";
import { readMigrationJournal } from "./migration-journal.mjs";
import { readPreparedRollbackIntent } from "./prepare-pre-exposure-rollback.mjs";
import { readRegularFile } from "./verify-artifact.mjs";
import { verifyOriginalUnitViewBoundary, verifyOriginalUnitViewRestored } from
  "./verify-original-unit-view.mjs";

const FORMAT = "dp-beget-bridge-live-replacement-ledger-v1";
const SHA = /^[0-9a-f]{64}$/;
function absolute(filename) {
  return typeof filename === "string" && path.isAbsolute(filename) &&
    path.normalize(filename) === filename && filename !== "/";
}
async function trustedParent(filename, rootOwner = false) {
  if (!absolute(filename)) throw new Error("Replacement ledger requires normalized absolute paths");
  const parent = path.dirname(filename);
  const info = await lstat(parent);
  if (!info.isDirectory() || (rootOwner && info.uid !== 0) || (info.mode & 0o022) !== 0 ||
      (await realpath(parent)) !== parent) throw new Error("Untrusted replacement ledger parent");
  return parent;
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function syncPreservedState(filename, kind) {
  if (kind === "config") {
    for (const name of await readdir(filename)) {
      const child = path.join(filename, name);
      const info = await lstat(child);
      if (info.isDirectory()) await syncPreservedState(child, "config");
      else if (info.isFile() && info.nlink === 1 && (await realpath(child)) === child) {
        const handle = await open(child, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await handle.sync(); } finally { await handle.close(); }
      } else throw new Error("Cannot preserve special configuration entry");
    }
    await syncDirectory(filename);
  } else {
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
}
async function missing(filename) {
  try { await lstat(filename); return false; }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
}
async function identity(filename, kind) {
  try {
    const info = await lstat(filename);
    if ((kind === "config" ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) ||
        (await realpath(filename)) !== filename) throw new Error("Unexpected recovery inode type");
    return { dev: info.dev, ino: info.ino, uid: info.uid, gid: info.gid, mode: info.mode & 0o777 };
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function fingerprint(filename, kind) {
  if (kind === "database") {
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const hash = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      return hash.digest("hex");
    } finally { await handle.close(); }
  }
  const hash = createHash("sha256");
  async function walk(directory, prefix) {
    const current = await identity(directory, "config");
    hash.update(JSON.stringify([prefix, "directory", current.uid, current.gid, current.mode]));
    for (const name of (await readdir(directory)).sort()) {
      const child = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(child);
      if (info.isDirectory()) await walk(child, relative);
      else if (info.isFile() && info.nlink === 1 && (await realpath(child)) === child) {
        hash.update(JSON.stringify([relative, "file", info.uid, info.gid, info.mode & 0o777]));
        const handle = await open(child, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const file = createHash("sha256");
          for await (const chunk of handle.createReadStream({ autoClose: false })) file.update(chunk);
          hash.update(file.digest("hex"));
        } finally { await handle.close(); }
      } else throw new Error("Unsafe recovery configuration entry");
    }
  }
  await walk(filename, "");
  return hash.digest("hex");
}
function validate(record) {
  if (!record || Object.keys(record).sort().join(",") !==
        "copyRecordPath,copyRecordSha256,format,migrationTransactionId,phase,targets" ||
      record.format !== FORMAT || !["prepared", "replacing", "replaced"].includes(record.phase) ||
      !/^[0-9a-f-]{36}$/.test(record.migrationTransactionId || "") ||
      !absolute(record.copyRecordPath) || !SHA.test(record.copyRecordSha256 || "") ||
      !Array.isArray(record.targets) || record.targets.length < 2 ||
      record.targets[0]?.kind !== "config" ||
      record.targets.slice(1).some(item => item.kind !== "database") ||
      record.targets.some(item => !item || Object.keys(item).sort().join(",") !==
        "copy,kind,live,name,newDev,newDigest,newGid,newIno,newMode,newUid,oldDev,oldIno,parked" ||
        ![item.copy, item.live, item.parked].every(absolute) ||
        !SHA.test(item.newDigest || "") ||
        ![item.newDev, item.newIno, item.newUid, item.newGid,
          item.oldDev, item.oldIno].every(Number.isSafeInteger) ||
        !Number.isInteger(item.newMode) || item.newMode < 0 || item.newMode > 0o777 ||
        (item.kind === "database" && !/^[a-z][a-z0-9_-]{0,31}$/.test(item.name || ""))) ||
      new Set(record.targets.flatMap(item => [item.live, item.copy, item.parked])).size !==
        record.targets.length * 3) {
    throw new Error("Invalid live replacement ledger");
  }
  return record;
}
export async function readLiveReplacementLedger(ledgerPath) {
  await trustedParent(ledgerPath, true);
  const info = await lstat(ledgerPath);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o077) !== 0 ||
      info.size > 64 * 1024 || (await realpath(ledgerPath)) !== ledgerPath) {
    throw new Error("Untrusted live replacement ledger");
  }
  return validate(JSON.parse((await readRegularFile(ledgerPath, 64 * 1024)).toString("utf8")));
}
async function targetPosition(item) {
  await trustedParent(item.live);
  await trustedParent(item.copy);
  await trustedParent(item.parked);
  if (path.dirname(item.live) !== path.dirname(item.copy) ||
      path.dirname(item.live) !== path.dirname(item.parked)) {
    throw new Error("Replacement target is not on one destination directory");
  }
  const [live, copy, parked] = await Promise.all([identity(item.live, item.kind),
    identity(item.copy, item.kind), identity(item.parked, item.kind)]);
  const old = value => value?.dev === item.oldDev && value.ino === item.oldIno;
  const next = value => value?.dev === item.newDev && value.ino === item.newIno;
  let position;
  let newPath;
  if (old(live) && next(copy) && !parked) { position = "pending"; newPath = item.copy; }
  else if (!live && next(copy) && old(parked)) { position = "parked"; newPath = item.copy; }
  else if (next(live) && !copy && old(parked)) { position = "installed"; newPath = item.live; }
  else throw new Error(`Unrecognized replacement position: ${item.name}`);
  const newInfo = position === "installed" ? live : copy;
  if (newInfo.uid !== item.newUid || newInfo.gid !== item.newGid ||
      newInfo.mode !== item.newMode) throw new Error(`Replacement ownership changed: ${item.name}`);
  if (await fingerprint(newPath, item.kind) !== item.newDigest) {
    throw new Error(`Replacement copy changed: ${item.name}`);
  }
  if (item.kind === "database") {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      if (!(await missing(`${item.live}${suffix}`))) throw new Error(`SQLite sidecar appeared: ${item.name}`);
    }
  }
  return position;
}

// Reopen the ledger even if a prior crash has left some live destinations
// absent or already replaced. The migration marker and original unit view
// must still hold; this inspector does not move files or start services.
export async function inspectLiveReplacementLedger({ ledgerPath, stateDatabase,
  ...boundary } = {}) {
  if (process.getuid?.() !== 0 || !absolute(stateDatabase)) {
    throw new Error("Root and original state database are required");
  }
  const record = await readLiveReplacementLedger(ledgerPath);
  const copyRecord = await readLiveStateCopyRecord(record.copyRecordPath);
  if (copyRecord.phase !== "prepared" ||
      createHash("sha256").update(await readRegularFile(record.copyRecordPath, 16 * 1024)).digest("hex") !==
        record.copyRecordSha256 || copyRecord.migrationTransactionId !== record.migrationTransactionId ||
      record.targets[0].live === stateDatabase ||
      !record.targets.some(item => item.kind === "database" && item.live === stateDatabase)) {
    throw new Error("Replacement ledger is not bound to prepared recovery copies");
  }
  const positions = [];
  for (const item of record.targets) positions.push(await targetPosition(item));
  if ((record.phase === "prepared" && positions.some(position => position !== "pending")) ||
      (record.phase === "replaced" && positions.some(position => position !== "installed"))) {
    throw new Error("Replacement ledger phase contradicts live inode positions");
  }
  const databaseIndex = record.targets.findIndex(item => item.live === stateDatabase);
  const databasePath = positions[databaseIndex] === "parked"
    ? record.targets[databaseIndex].parked : stateDatabase;
  const { journal } = await verifyOriginalUnitViewBoundary({ ...boundary,
    planPath: copyRecord.planPath, stopRecordPath: copyRecord.stopRecordPath,
    unitRecordPath: copyRecord.unitRecordPath, stateDatabase: databasePath });
  if (journal.transactionId !== record.migrationTransactionId) {
    throw new Error("Replacement ledger belongs to another migration");
  }
  for (let index = 0; index < record.targets.length; index++) {
    if (await targetPosition(record.targets[index]) !== positions[index]) {
      throw new Error("Replacement positions changed during inspection");
    }
  }
  return { record, positions };
}

// This first step is intentionally inert: it captures old/new inode identities
// and exact new content before any live rename. A later controller will
// durably change 'prepared' to 'replacing' before its first rename.
export async function prepareLiveReplacementLedger({ ledgerPath, recordPath,
  stateDatabase, ...boundary } = {}) {
  if (process.getuid?.() !== 0 || !absolute(ledgerPath) || !absolute(recordPath) ||
      ledgerPath === recordPath) throw new Error("Root and separate ledger paths are required");
  const parent = await trustedParent(ledgerPath, true);
  const copies = await verifyPreparedLiveStateCopies({ ...boundary, recordPath, stateDatabase });
  const view = await verifyOriginalUnitViewRestored({ ...boundary,
    planPath: copies.planPath, stopRecordPath: copies.stopRecordPath,
    unitRecordPath: copies.unitRecordPath, stateDatabase });
  if (!view.destinations.databases.some(item => item.path === stateDatabase)) {
    throw new Error("Operation ledger database is outside the snapshot destinations");
  }
  const intent = await readPreparedRollbackIntent(copies.planPath);
  const journal = await readMigrationJournal(intent.journalPath);
  if ([view.stagedDirectory, journal.snapshotPath, journal.unitBackup.path,
    boundary.unitDirectory || "/etc/systemd/system", copies.configCopy].some(directory =>
    ledgerPath === directory || ledgerPath.startsWith(`${directory}${path.sep}`))) {
    throw new Error("Replacement ledger must be outside staged, backup and live unit directories");
  }
  const suffix = randomUUID();
  const targets = [{ name: "config", kind: "config", live: view.destinations.configRoot,
    copy: copies.configCopy }, ...copies.databases.map(item => ({ name: item.name,
    kind: "database", live: item.source, copy: item.copy }))];
  for (const item of targets) {
    item.parked = `${item.live}.r0004-parked-${suffix}`;
    await trustedParent(item.parked);
    if (!(await missing(item.parked)) || path.dirname(item.live) !== path.dirname(item.copy)) {
      throw new Error("Replacement parking path is unavailable or on another directory");
    }
    const old = await identity(item.live, item.kind);
    const next = await identity(item.copy, item.kind);
    if (!old || !next || old.dev !== next.dev) throw new Error("Recovery copies cannot be renamed atomically");
    item.oldDev = old.dev; item.oldIno = old.ino;
    item.newDev = next.dev; item.newIno = next.ino;
    item.newUid = next.uid; item.newGid = next.gid; item.newMode = next.mode;
    item.newDigest = await fingerprint(item.copy, item.kind);
  }
  if (targets.some(item => ledgerPath === item.live || ledgerPath === item.copy ||
      ledgerPath === item.parked || ledgerPath.startsWith(`${item.live}${path.sep}`))) {
    throw new Error("Replacement ledger overlaps live or staged state");
  }
  const record = validate({ format: FORMAT, phase: "prepared",
    migrationTransactionId: view.transactionId, copyRecordPath: recordPath,
    copyRecordSha256: createHash("sha256").update(await readRegularFile(recordPath, 16 * 1024)).digest("hex"),
    targets });
  const handle = await open(ledgerPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(parent);
  await inspectLiveReplacementLedger({ ...boundary, ledgerPath, stateDatabase });
  return record;
}

async function changePhase(ledgerPath, before, after) {
  const current = await readLiveReplacementLedger(ledgerPath);
  if (JSON.stringify(current) !== JSON.stringify(before)) {
    throw new Error("Replacement ledger changed before durable phase transition");
  }
  const next = validate({ ...current, phase: after });
  const temporary = `${ledgerPath}.${randomUUID()}.tmp`;
  const handle = await open(temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(next) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, ledgerPath);
  await syncDirectory(path.dirname(ledgerPath));
  return next;
}

// Each same-directory rename is followed by a directory sync and a full
// position/boundary recheck. On failure, the persistent marker and the
// 'replacing' record remain. Calling again resumes a recognized parked or
// installed position; an unknown inode fails closed for manual inspection.
export async function replaceLiveStateFromLedger({ ledgerPath, stateDatabase,
  renameEntry = rename, ...boundary } = {}) {
  if (process.getuid?.() !== 0 || !absolute(ledgerPath) || !absolute(stateDatabase)) {
    throw new Error("Root, replacement ledger and state database are required");
  }
  let { record, positions } = await inspectLiveReplacementLedger({ ...boundary,
    ledgerPath, stateDatabase });
  if (record.phase === "replaced") return { record, positions };
  if (record.phase === "prepared") {
    const copies = await readLiveStateCopyRecord(record.copyRecordPath);
    await verifyPreparedLiveStateCopies({ ...boundary, recordPath: record.copyRecordPath,
      planPath: copies.planPath, stopRecordPath: copies.stopRecordPath,
      unitRecordPath: copies.unitRecordPath, stateDatabase });
    record = await changePhase(ledgerPath, record, "replacing");
    ({ positions } = await inspectLiveReplacementLedger({ ...boundary, ledgerPath, stateDatabase }));
  }
  for (let index = 0; index < record.targets.length; index++) {
    const item = record.targets[index];
    if (positions[index] === "pending") {
      await syncPreservedState(item.live, item.kind);
      ({ positions } = await inspectLiveReplacementLedger({ ...boundary, ledgerPath, stateDatabase }));
      if (positions[index] !== "pending") throw new Error(`Old state changed before parking: ${item.name}`);
      await renameEntry(item.live, item.parked);
      await syncDirectory(path.dirname(item.live));
      ({ positions } = await inspectLiveReplacementLedger({ ...boundary, ledgerPath, stateDatabase }));
      if (positions[index] !== "parked") throw new Error(`Old state parking is uncertain: ${item.name}`);
    }
    if (positions[index] === "parked") {
      await renameEntry(item.copy, item.live);
      await syncDirectory(path.dirname(item.live));
      ({ positions } = await inspectLiveReplacementLedger({ ...boundary, ledgerPath, stateDatabase }));
      if (positions[index] !== "installed") throw new Error(`Restored state placement is uncertain: ${item.name}`);
    }
    if (positions[index] !== "installed") throw new Error(`Replacement position changed: ${item.name}`);
  }
  if (positions.some(position => position !== "installed")) {
    throw new Error("Live replacement is incomplete");
  }
  record = await changePhase(ledgerPath, record, "replaced");
  return inspectLiveReplacementLedger({ ...boundary, ledgerPath, stateDatabase });
}

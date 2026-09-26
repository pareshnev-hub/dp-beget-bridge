import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readlink, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { inspectLiveReplacementLedger } from "./live-state-replacement-ledger.mjs";
import { readMigrationJournal } from "./migration-journal.mjs";
import { readPreparedRollbackIntent } from "./prepare-pre-exposure-rollback.mjs";
import { readLiveStateCopyRecord } from "./stage-live-state-recovery.mjs";
import { readRegularFile } from "./verify-artifact.mjs";

const FORMAT = "dp-beget-bridge-first-migration-pointer-rollback-v1";
const VERSION = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?)-([0-9a-f]{40})$/;
const SHA = /^[0-9a-f]{64}$/;
function absolute(filename) {
  return typeof filename === "string" && path.isAbsolute(filename) &&
    path.normalize(filename) === filename && filename !== "/";
}
async function trustedDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
      (await realpath(directory)) !== directory) throw new Error("Untrusted release pointer directory");
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function absent(filename) {
  try { await lstat(filename); return false; }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
}
function validate(record) {
  if (!record || Object.keys(record).sort().join(",") !==
        "format,ledgerPath,ledgerSha256,migrationTransactionId,phase,releaseRoot,target" ||
      record.format !== FORMAT || !["prepared", "removing", "removed"].includes(record.phase) ||
      !absolute(record.ledgerPath) || !absolute(record.releaseRoot) ||
      !SHA.test(record.ledgerSha256 || "") ||
      !/^[0-9a-f-]{36}$/.test(record.migrationTransactionId || "") ||
      typeof record.target !== "string" || !record.target.startsWith("releases/") ||
      !VERSION.test(record.target.slice("releases/".length))) {
    throw new Error("Invalid candidate pointer rollback record");
  }
  return record;
}
export async function readCandidatePointerRollbackRecord(recordPath) {
  if (!absolute(recordPath)) throw new Error("Absolute pointer rollback record path required");
  await trustedDirectory(path.dirname(recordPath));
  const info = await lstat(recordPath);
  if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 || info.size > 4096 ||
      (await realpath(recordPath)) !== recordPath) {
    throw new Error("Untrusted candidate pointer rollback record");
  }
  return validate(JSON.parse((await readRegularFile(recordPath, 4096)).toString("utf8")));
}
async function pointerView(releaseRoot, target) {
  await trustedDirectory(releaseRoot);
  await trustedDirectory(path.join(releaseRoot, "releases"));
  if (!(await absent(path.join(releaseRoot, "previous"))) ||
      !(await absent(path.join(releaseRoot, ".activation.lock")))) {
    throw new Error("First migration requires no previous release or activation lock");
  }
  const directory = path.join(releaseRoot, target);
  await trustedDirectory(directory);
  const match = VERSION.exec(target.slice("releases/".length));
  const packagePath = path.join(directory, "package.json");
  const packageInfo = await lstat(packagePath);
  if (!packageInfo.isFile() || packageInfo.nlink !== 1 || packageInfo.uid !== 0 ||
      (packageInfo.mode & 0o022) !== 0 || (await realpath(packagePath)) !== packagePath) {
    throw new Error("Untrusted candidate package metadata");
  }
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  if (pkg.name !== "dp-beget-bridge" || pkg.version !== match[1]) {
    throw new Error("Candidate release directory differs from version pointer");
  }
  const current = path.join(releaseRoot, "current");
  if (await absent(current)) return "absent";
  const info = await lstat(current);
  if (!info.isSymbolicLink() || (await readlink(current)) !== target) {
    throw new Error("Current release pointer changed from journaled candidate");
  }
  return "candidate";
}
async function replacementProof({ ledgerPath, stateDatabase, ...boundary }) {
  const inspected = await inspectLiveReplacementLedger({ ...boundary, ledgerPath, stateDatabase });
  if (inspected.record.phase !== "replaced" ||
      inspected.positions.some(position => position !== "installed")) {
    throw new Error("Live old-state replacement has not completed");
  }
  const copies = await readLiveStateCopyRecord(inspected.record.copyRecordPath);
  const intent = await readPreparedRollbackIntent(copies.planPath);
  const journal = await readMigrationJournal(intent.journalPath);
  if (journal.transactionId !== inspected.record.migrationTransactionId ||
      journal.phase !== "locally-healthy") throw new Error("Migration changed after state replacement");
  return { journal, intent, inspected };
}
async function update(recordPath, previous, phase) {
  if (JSON.stringify(await readCandidatePointerRollbackRecord(recordPath)) !== JSON.stringify(previous)) {
    throw new Error("Candidate pointer rollback record changed");
  }
  const next = validate({ ...previous, phase });
  const temporary = `${recordPath}.${randomUUID()}.tmp`;
  const handle = await open(temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(next) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, recordPath);
  await syncDirectory(path.dirname(recordPath));
  return next;
}

// R0003 still runs from its original unit fragments and separate code root.
// With old state installed and all writers stopped, remove only the first
// migration candidate's managed current link. No old service is started here.
export async function deactivateCandidatePointer({ recordPath, ledgerPath, stateDatabase,
  releaseRoot, versionDir, unlinkPointer = unlink, ...boundary } = {}) {
  if (process.getuid?.() !== 0 || ![recordPath, ledgerPath, stateDatabase, releaseRoot].every(absolute) ||
      !VERSION.test(versionDir || "") || recordPath === ledgerPath ||
      recordPath.startsWith(`${releaseRoot}${path.sep}`)) {
    throw new Error("Root, first-migration pointer and separate rollback record are required");
  }
  await trustedDirectory(path.dirname(recordPath));
  const { journal, intent, inspected } = await replacementProof({ ...boundary, ledgerPath, stateDatabase });
  if (!versionDir.endsWith(`-${journal.newCommit}`)) throw new Error("Candidate commit differs from migration");
  if ([intent.stagedDirectory, journal.snapshotPath, journal.unitBackup.path,
    boundary.unitDirectory || "/etc/systemd/system",
    ...inspected.record.targets.filter(item => item.kind === "config").flatMap(item =>
      [item.live, item.parked])].some(directory =>
    recordPath === directory || recordPath.startsWith(`${directory}${path.sep}`)) ||
      inspected.record.targets.some(item => [item.live, item.copy, item.parked].includes(recordPath))) {
    throw new Error("Pointer rollback record must be outside live state, units and backups");
  }
  const target = `releases/${versionDir}`;
  const digest = createHash("sha256").update(await readRegularFile(ledgerPath, 64 * 1024)).digest("hex");
  let record;
  if (await absent(recordPath)) {
    if (await pointerView(releaseRoot, target) !== "candidate") {
      throw new Error("Candidate current pointer was removed without rollback intent");
    }
    record = validate({ format: FORMAT, phase: "prepared", releaseRoot, target, ledgerPath,
      ledgerSha256: digest, migrationTransactionId: journal.transactionId });
    const handle = await open(recordPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    await syncDirectory(path.dirname(recordPath));
  } else record = await readCandidatePointerRollbackRecord(recordPath);
  if (record.releaseRoot !== releaseRoot || record.target !== target ||
      record.ledgerPath !== ledgerPath || record.ledgerSha256 !== digest ||
      record.migrationTransactionId !== journal.transactionId) {
    throw new Error("Candidate pointer rollback record belongs to another migration");
  }
  let view = await pointerView(releaseRoot, target);
  if (record.phase === "prepared") {
    if (view !== "candidate") throw new Error("Pointer changed before removal intent");
    record = await update(recordPath, record, "removing");
  }
  if (record.phase === "removing") {
    if (view === "candidate") {
      await unlinkPointer(path.join(releaseRoot, "current"));
    }
    // Also sync when resuming after an unlink that succeeded but whose
    // directory sync or caller failed before the phase was recorded.
    await syncDirectory(releaseRoot);
    view = await pointerView(releaseRoot, target);
    if (view !== "absent") throw new Error("Candidate pointer removal is uncertain");
    record = await update(recordPath, record, "removed");
  }
  if (record.phase !== "removed" || await pointerView(releaseRoot, target) !== "absent") {
    throw new Error("Candidate pointer rollback is incomplete");
  }
  await replacementProof({ ...boundary, ledgerPath, stateDatabase });
  return record;
}

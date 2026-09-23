import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertBridgeWritersStopped } from "./backup-state-bundle.mjs";
import { inspectInstalledManagedUnits } from "./installed-managed-unit-preflight.mjs";
import { inspectInstalledWriterGuards } from "./installed-writer-guard-preflight.mjs";
import { PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";
import { advanceMigrationJournal, readMigrationJournal, verifyJournalUnitBackup } from "./migration-journal.mjs";
import { verifyMarker } from "./quiesce-legacy-writers.mjs";
import { verifyJournalStateBundle } from "./snapshot-legacy-state.mjs";
import { MANAGED_APP_UNITS, MANAGED_DROP_IN, managedUnitContent } from "./stage-managed-unit-overrides.mjs";
import { readRegularFile } from "./verify-artifact.mjs";
import { WRITER_GUARD_DROP_IN, WRITER_START_PERMIT } from "./writer-boot-guard.mjs";

const exec = promisify(execFile);
const INGRESS = ["dp-beget-oauth-proxy.socket", "dp-beget-oauth-proxy.service", "dp-beget-tunnel.service"];

async function reloadSystemd() { await exec("systemctl", ["daemon-reload"], { timeout: 20000, maxBuffer: 4096 }); }
async function systemctlState(unit) {
  const { stdout } = await exec("systemctl", ["show", unit, "--property=ActiveState", "--no-pager"],
    { timeout: 5000, maxBuffer: 4096 });
  if (!/^ActiveState=[a-z-]+\n$/.test(stdout)) throw new Error(`Invalid state for ${unit}`);
  return stdout.trim().slice("ActiveState=".length);
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function trustedDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
      (await realpath(directory)) !== directory) throw new Error("Untrusted managed unit directory");
}

async function assertOriginalAppUnits(journal, unitDirectory) {
  const manifest = JSON.parse(await readRegularFile(path.join(journal.unitBackup.path,
    "backup-manifest.json"), 64 * 1024));
  for (const item of manifest.files.filter(file => MANAGED_APP_UNITS.includes(file.unit))) {
    const filename = path.join(unitDirectory, item.path);
    const info = await lstat(filename);
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (await realpath(filename)) !== filename ||
        createHash("sha256").update(await readRegularFile(filename, 64 * 1024)).digest("hex") !== item.sha256) {
      throw new Error("Installed legacy app units differ from their snapshot");
    }
  }
}

// Without a journaled rollback controller this has no CLI entry point.
export async function installManagedOverrides({ journalPath, marker = PERSISTENT_MARKER,
  unitDirectory = "/etc/systemd/system", stagedDirectory, releaseRoot, permit = WRITER_START_PERMIT,
  assertWritersStopped = assertBridgeWritersStopped, getState = systemctlState,
  daemonReload = reloadSystemd, inspectInstalled = inspectInstalledManagedUnits,
  inspectWriterGuards = inspectInstalledWriterGuards } = {}) {
  if (process.getuid?.() !== 0 || !path.isAbsolute(stagedDirectory || "")) {
    throw new Error("Root and a private staged override directory are required");
  }
  const journal = await readMigrationJournal(journalPath);
  if (journal.phase !== "snapshotted") throw new Error("A journal-bound stopped-state snapshot is required");
  await verifyJournalUnitBackup(journal);
  await verifyJournalStateBundle(journal);
  await verifyMarker(marker);
  await trustedDirectory(unitDirectory);
  await trustedDirectory(stagedDirectory);
  await inspectWriterGuards({ unitDirectory, marker, permit });
  try { await lstat(permit); throw new Error("Writer start permit remains active during snapshot switch"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await assertWritersStopped();
  for (const unit of INGRESS) {
    if (await getState(unit) !== "inactive") throw new Error(`Ingress remains active: ${unit}`);
  }
  await assertOriginalAppUnits(journal, unitDirectory);
  const content = managedUnitContent(releaseRoot);
  for (const unit of MANAGED_APP_UNITS) {
    const source = path.join(stagedDirectory, `${unit}.d`, MANAGED_DROP_IN);
    const info = await lstat(source);
    if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o077) !== 0 ||
        (await realpath(source)) !== source ||
        (await readRegularFile(source, 4096)).toString("utf8") !== content) {
      throw new Error(`Untrusted staged managed override for ${unit}`);
    }
    const directory = path.join(unitDirectory, `${unit}.d`);
    try { await trustedDirectory(directory); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const entries = await readdir(directory).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error));
    const expected = unit === "dp-beget-mcp-oauth-spike.service"
      ? ["10-dp012-dcr.conf", WRITER_GUARD_DROP_IN] : [WRITER_GUARD_DROP_IN];
    if (JSON.stringify(entries.sort()) !== JSON.stringify(expected)) {
      throw new Error(`Unexpected existing override for ${unit}`);
    }
  }
  // Intent is synced before the first externally visible unit file change.
  await advanceMigrationJournal(journalPath, "snapshotted", "switched");
  for (const unit of MANAGED_APP_UNITS) {
    const directory = path.join(unitDirectory, `${unit}.d`);
    try { await mkdir(directory, { mode: 0o755 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    await trustedDirectory(directory);
    const target = path.join(directory, MANAGED_DROP_IN);
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(directory);
  }
  await syncDirectory(unitDirectory);
  await daemonReload();
  await inspectInstalled({ unitDirectory, releaseRoot });
  return { units: [...MANAGED_APP_UNITS], releaseRoot };
}

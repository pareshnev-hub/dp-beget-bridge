import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { guardContent, INGRESS_UNITS, PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";
import { inspectInstalledIngressGuard } from "./installed-ingress-guard-preflight.mjs";
import { inspectInstalledWriterGuards } from "./installed-writer-guard-preflight.mjs";
import { advanceMigrationJournal, readMigrationJournal, verifyJournalUnitBackup } from "./migration-journal.mjs";
import { MANAGED_APP_UNITS } from "./stage-managed-unit-overrides.mjs";
import { readRegularFile } from "./verify-artifact.mjs";
import { WRITER_GUARD_DROP_IN, WRITER_START_PERMIT, writerGuardContent } from "./writer-boot-guard.mjs";
import { assertWriterPermitAbsent } from "./writer-start-permit.mjs";

const exec = promisify(execFile);
const INGRESS_GUARD = "90-dp-r0004-migration-guard.conf";
const UNITS = [...MANAGED_APP_UNITS, ...INGRESS_UNITS];

async function trustedDirectory(directory, privateMode = false) {
  const info = await stat(directory);
  if (!path.isAbsolute(directory || "") || path.normalize(directory) !== directory ||
      (await realpath(directory)) !== directory || !info.isDirectory() || info.uid !== 0 ||
      (info.mode & (privateMode ? 0o077 : 0o022)) !== 0) {
    throw new Error("Untrusted systemd guard directory");
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function systemdReload() {
  await exec("systemctl", ["daemon-reload"], { timeout: 20000, maxBuffer: 4096 });
}

async function assertNoMarker(marker) {
  try { await lstat(marker); throw new Error("Migration marker already exists; recovery required"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function assertOriginalLayout(journal, unitDirectory) {
  const manifest = JSON.parse(await readRegularFile(path.join(journal.unitBackup.path,
    "backup-manifest.json"), 64 * 1024));
  const expected = [...UNITS, "dp-beget-mcp-oauth-spike.service.d/10-dp012-dcr.conf"].sort();
  if (JSON.stringify(manifest.files.map(item => item.path).sort()) !== JSON.stringify(expected)) {
    throw new Error("Unsupported legacy unit backup layout for guard installation");
  }
  for (const entry of manifest.files) {
    const filename = path.join(unitDirectory, entry.path);
    const info = await lstat(filename);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== entry.uid || info.gid !== entry.gid ||
        (info.mode & 0o777) !== entry.mode || (await realpath(filename)) !== filename ||
        createHash("sha256").update(await readRegularFile(filename, 64 * 1024)).digest("hex") !== entry.sha256) {
      throw new Error(`Legacy systemd file changed: ${entry.path}`);
    }
  }
  for (const unit of UNITS) {
    const directory = path.join(unitDirectory, `${unit}.d`);
    let names;
    try { await trustedDirectory(directory); names = await readdir(directory); }
    catch (error) { if (error.code !== "ENOENT") throw error; names = []; }
    const expectedEntries = unit === "dp-beget-mcp-oauth-spike.service" ? ["10-dp012-dcr.conf"] : [];
    if (JSON.stringify(names.sort()) !== JSON.stringify(expectedEntries)) {
      throw new Error(`Unexpected existing drop-in for ${unit}`);
    }
  }
}

async function stagedGuard(filename, expected) {
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o077) !== 0 ||
      (await realpath(filename)) !== filename ||
      (await readRegularFile(filename, 4096)).toString("utf8") !== expected) {
    throw new Error("Untrusted staged boot guard");
  }
}

// Installs guards before the persistent marker is written. On partial failure
// the journal stays guarded, but without a marker old services still start.
// Recovery must inspect/reconcile all seven drop-ins before closing ingress.
export async function installMigrationBootGuards({ journalPath, unitDirectory = "/etc/systemd/system",
  stagedIngress, stagedWriters, marker = PERSISTENT_MARKER, permit = WRITER_START_PERMIT,
  daemonReload = systemdReload, inspectIngress = inspectInstalledIngressGuard,
  inspectWriters = inspectInstalledWriterGuards } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to install migration boot guards");
  const journal = await readMigrationJournal(journalPath);
  if (journal.phase !== "prepared") throw new Error("Unit guard installation requires prepared journal");
  await verifyJournalUnitBackup(journal);
  await trustedDirectory(unitDirectory);
  await trustedDirectory(stagedIngress, true);
  await trustedDirectory(stagedWriters, true);
  await assertNoMarker(marker);
  await assertWriterPermitAbsent(permit);
  await assertOriginalLayout(journal, unitDirectory);
  const entries = [
    ...INGRESS_UNITS.map(unit => ({ unit, name: INGRESS_GUARD, directory: stagedIngress,
      content: guardContent(marker) })),
    ...MANAGED_APP_UNITS.map(unit => ({ unit, name: WRITER_GUARD_DROP_IN, directory: stagedWriters,
      content: writerGuardContent(marker, permit) }))
  ];
  for (const entry of entries) {
    await stagedGuard(path.join(entry.directory, `${entry.unit}.d`, entry.name), entry.content);
  }
  // Commit intent before the first new unit file. There is no auto-cleanup of
  // partially installed guards; the original backup remains available.
  await advanceMigrationJournal(journalPath, "prepared", "guarded");
  for (const entry of entries) {
    const directory = path.join(unitDirectory, `${entry.unit}.d`);
    try { await mkdir(directory, { mode: 0o755 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    await trustedDirectory(directory);
    const handle = await open(path.join(directory, entry.name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(entry.content); await handle.sync(); }
    finally { await handle.close(); }
    await syncDirectory(directory);
  }
  await syncDirectory(unitDirectory);
  await daemonReload();
  await inspectIngress({ unitDirectory, marker });
  await inspectWriters({ unitDirectory, marker, permit });
  return { guardedUnits: [...UNITS], marker, permit };
}

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { guardContent, PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";
import { inspectInstalledIngressGuard } from "./installed-ingress-guard-preflight.mjs";
import { inspectLegacyServiceActivity, LEGACY_UNITS, validateLegacyServiceActivity } from "./legacy-service-activity.mjs";
import { advanceMigrationJournal, readMigrationJournal, verifyJournalUnitBackup } from "./migration-journal.mjs";
import { verifyMarker } from "./quiesce-legacy-writers.mjs";

const exec = promisify(execFile);
const STOP_ORDER = Object.freeze([
  "dp-beget-oauth-proxy.socket", "dp-beget-oauth-proxy.service", "dp-beget-tunnel.service"
]);

async function systemctlStop(unit) {
  await exec("systemctl", ["stop", unit], { timeout: 20000, maxBuffer: 4096 });
}

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

export async function createPersistentMarker(marker) {
  guardContent(marker);
  const parent = path.dirname(marker);
  const info = await stat(parent);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
      (await realpath(parent)) !== parent) throw new Error("Untrusted persistent marker parent");
  const handle = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile("dp-beget-bridge-migration-incomplete-v1\n"); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(parent);
}

export async function removePersistentMarker(marker) {
  await verifyMarker(marker);
  await unlink(marker);
  await syncDirectory(path.dirname(marker));
}

// No CLI entry point: the route-target proof and migration installer must invoke this
// only after the unit snapshot, guard install and daemon-reload have been verified.
export async function closeLegacyIngress({ journalPath, unitDirectory, marker = PERSISTENT_MARKER,
  inspectGuard = inspectInstalledIngressGuard, inspectServices = inspectLegacyServiceActivity,
  stopUnit = systemctlStop, getState = systemctlState } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to close legacy ingress");
  const journal = await readMigrationJournal(journalPath);
  if (journal.phase !== "guarded") throw new Error("Migration must have verified the installed guard");
  await verifyJournalUnitBackup(journal);
  await inspectGuard({ unitDirectory, marker });
  const now = validateLegacyServiceActivity(await inspectServices());
  if (LEGACY_UNITS.some(unit => now[unit] !== journal.serviceActivity[unit])) {
    throw new Error("Legacy service activity changed since migration inventory");
  }
  try { await lstat(marker); throw new Error("Migration marker already exists; recovery is required"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // The marker must be durable before any journal claim that ingress is closed.
  // On failure or power loss, it remains in place and boot refuses ingress.
  await createPersistentMarker(marker);
  await advanceMigrationJournal(journalPath, "guarded", "ingress-closed");
  for (const unit of STOP_ORDER) await stopUnit(unit);
  for (const unit of STOP_ORDER) {
    if (await getState(unit) !== "inactive") throw new Error(`Ingress remains active: ${unit}`);
  }
  return { closed: [...STOP_ORDER], marker };
}

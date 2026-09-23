import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertSessionHostRestartSafe } from "../deploy/session-host-restart-preflight.mjs";
import { PERSISTENT_MARKER, guardContent } from "./ingress-boot-guard.mjs";
import { advanceMigrationJournal, readMigrationJournal, verifyJournalUnitBackup } from "./migration-journal.mjs";

const exec = promisify(execFile);
const INGRESS = ["dp-beget-oauth-proxy.socket", "dp-beget-oauth-proxy.service", "dp-beget-tunnel.service"];
const STOP_ORDER = ["dp-beget-mcp-oauth-spike.service", "dp-beget-mcp.service",
  "dp-beget-agent.service", "dp-beget-session-host.service"];

async function systemctlShow(unit, property) {
  const { stdout } = await exec("systemctl", ["show", unit, `--property=${property}`, "--no-pager"],
    { timeout: 5000, maxBuffer: 4096 });
  const match = /^([A-Za-z]+)=([a-z-]+)\n$/.exec(stdout);
  if (!match || match[1] !== property) throw new Error(`Invalid systemd ${property} for ${unit}`);
  return match[2];
}

async function systemctlStop(unit) {
  await exec("systemctl", ["stop", unit], { timeout: 20000, maxBuffer: 4096 });
}

export async function verifyMarker(marker) {
  guardContent(marker);
  const parent = path.dirname(marker);
  const parentInfo = await stat(parent);
  if (!parentInfo.isDirectory() || parentInfo.uid !== 0 || (parentInfo.mode & 0o022) !== 0 ||
      (await realpath(parent)) !== parent) throw new Error("Untrusted migration marker parent");
  const info = await lstat(marker);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
      info.size !== 40 || (await realpath(marker)) !== marker) {
    throw new Error("Untrusted persistent migration marker");
  }
  const handle = await open(marker, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((await handle.readFile("utf8")) !== "dp-beget-bridge-migration-incomplete-v1\n") {
      throw new Error("Untrusted persistent migration marker");
    }
  } finally { await handle.close(); }
}

// R0003 cannot report R0004 admission drain. The caller must provide an independent
// bounded proof that already accepted requests have finished before any writer stops.
export async function quiesceLegacyWriters({ journalPath, marker = PERSISTENT_MARKER, stateDatabase,
  assertNoInFlight, stopUnit = systemctlStop, getState = unit => systemctlShow(unit, "ActiveState"),
  getKillMode = unit => systemctlShow(unit, "KillMode"), assertLedgerSafe = assertSessionHostRestartSafe } = {}) {
  if (process.getuid?.() !== 0 || typeof assertNoInFlight !== "function" ||
      !path.isAbsolute(stateDatabase || "")) {
    throw new Error("Root, absolute ledger path and independent in-flight proof are required");
  }
  const journal = await readMigrationJournal(journalPath);
  if (journal.phase !== "ingress-closed") throw new Error("Ingress must be journaled closed first");
  await verifyJournalUnitBackup(journal);
  await verifyMarker(marker);
  for (const unit of INGRESS) {
    if (await getState(unit) !== "inactive") throw new Error(`Ingress remains active: ${unit}`);
  }
  await assertNoInFlight();
  if (await getKillMode("dp-beget-session-host.service") !== "process") {
    throw new Error("Session Host restart could terminate retained tmux processes");
  }
  // Intent precedes the first stop; on failure the persistent marker keeps ingress closed.
  await advanceMigrationJournal(journalPath, "ingress-closed", "quiesced");
  for (const unit of STOP_ORDER) {
    if (unit === "dp-beget-session-host.service") await assertLedgerSafe(stateDatabase);
    await stopUnit(unit);
    if (await getState(unit) !== "inactive") throw new Error(`Writer remains active: ${unit}`);
  }
  return { stopped: [...STOP_ORDER], marker };
}

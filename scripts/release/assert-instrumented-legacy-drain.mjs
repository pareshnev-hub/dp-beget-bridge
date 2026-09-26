import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { readMigrationJournal, verifyJournalUnitBackup } from "./migration-journal.mjs";
import { PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";
import { probeLegacyLocalHealth } from "./probe-legacy-health.mjs";
import { verifyMarker } from "./quiesce-legacy-writers.mjs";

const exec = promisify(execFile);
const WRITERS = ["dp-beget-agent.service", "dp-beget-mcp.service",
  "dp-beget-mcp-oauth-spike.service", "dp-beget-session-host.service"];
const INGRESS = ["dp-beget-oauth-proxy.socket", "dp-beget-oauth-proxy.service",
  "dp-beget-tunnel.service"];

async function showUnit(unit) {
  const { stdout } = await exec("systemctl", ["show", unit,
    "--property=LoadState,ActiveState,MainPID", "--no-pager"],
  { timeout: 5000, maxBuffer: 4096 });
  const fields = Object.create(null);
  for (const line of stdout.trim().split("\n")) {
    const at = line.indexOf("=");
    const key = line.slice(0, at);
    if (at < 1 || !["LoadState", "ActiveState", "MainPID"].includes(key) ||
        Object.hasOwn(fields, key)) throw new Error("Invalid legacy unit state");
    fields[key] = line.slice(at + 1);
  }
  return fields;
}

async function capture(readUnit, readHealth) {
  const states = await Promise.all([...WRITERS, ...INGRESS].map(readUnit));
  for (let index = 0; index < states.length; index++) {
    const state = states[index];
    const writer = index < WRITERS.length;
    if (state?.LoadState !== "loaded" ||
        state.ActiveState !== (writer ? "active" : "inactive") ||
        (writer && !/^[1-9][0-9]*$/.test(state.MainPID || "")) ||
        (!writer && state.MainPID !== "0")) {
      throw new Error("Legacy writer or dedicated ingress state changed during drain");
    }
  }
  const health = await readHealth({ requireCounters: true });
  if (health?.services !== 4 || !Array.isArray(health.inFlightRequests) ||
      health.inFlightRequests.length !== 4 || health.inFlightRequests.some(value =>
        !Number.isSafeInteger(value) || value !== 0)) {
    throw new Error("Legacy requests are active or counter evidence is unavailable");
  }
  return states.slice(0, WRITERS.length).map(state => state.MainPID);
}

// Callable only after closing all independent public ingress. R0003 must first
// ship a counter-only health hotfix across all four processes. This still
// requires a separately implemented exclusive-route proof from the caller.
export async function assertInstrumentedLegacyDrain({ journalPath, marker = PERSISTENT_MARKER,
  assertRouteExclusive, readUnit = showUnit, readHealth = probeLegacyLocalHealth,
  verifyClosedMarker = verifyMarker, wait = delay } = {}) {
  if (process.getuid?.() !== 0 || typeof assertRouteExclusive !== "function") {
    throw new Error("Root and independent exclusive-route proof are required for legacy drain");
  }
  const journal = await readMigrationJournal(journalPath);
  if (journal.phase !== "ingress-closed") throw new Error("Legacy ingress must be closed before drain");
  await verifyJournalUnitBackup(journal);
  await verifyClosedMarker(marker);
  if (await assertRouteExclusive() !== true) throw new Error("Legacy route is not exclusive");
  const before = await capture(readUnit, readHealth);
  await wait(1000);
  const after = await capture(readUnit, readHealth);
  await verifyClosedMarker(marker);
  const current = await readMigrationJournal(journalPath);
  if (current.transactionId !== journal.transactionId || current.phase !== "ingress-closed" ||
      before.some((pid, index) => pid !== after[index]) ||
      await assertRouteExclusive() !== true) {
    throw new Error("Legacy drain boundary changed during the observation");
  }
  return true;
}

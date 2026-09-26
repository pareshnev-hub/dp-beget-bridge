import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { pauseAdmission } from "./admission-pause.mjs";
import { assertBridgeWritersStopped } from "./backup-state-bundle.mjs";
import { PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";
import { inspectInstalledManagedUnits } from "./installed-managed-unit-preflight.mjs";
import { advanceMigrationJournal, readMigrationJournal, verifyJournalUnitBackup } from "./migration-journal.mjs";
import { verifyMarker } from "./quiesce-legacy-writers.mjs";
import { verifyJournalStateBundle } from "./snapshot-legacy-state.mjs";
import { localReleaseHealthProbes, waitForAdmissionDrain } from "./wait-admission-drain.mjs";
import { switchVersion } from "./version-pointer.mjs";
import { assertWriterPermitAbsent, withWriterStartPermit } from "./writer-start-permit.mjs";
import { WRITER_START_PERMIT } from "./writer-boot-guard.mjs";

const exec = promisify(execFile);
const START_ORDER = Object.freeze(["dp-beget-session-host.service", "dp-beget-agent.service",
  "dp-beget-mcp.service", "dp-beget-mcp-oauth-spike.service"]);
const INGRESS = ["dp-beget-oauth-proxy.socket", "dp-beget-oauth-proxy.service", "dp-beget-tunnel.service"];

async function systemctlStart(unit) {
  await exec("systemctl", ["start", unit], { timeout: 20000, maxBuffer: 4096 });
}
async function systemctlStop(unit) {
  await exec("systemctl", ["stop", unit], { timeout: 20000, maxBuffer: 4096 });
}
async function systemctlState(unit) {
  const { stdout } = await exec("systemctl", ["show", unit, "--property=ActiveState", "--no-pager"],
    { timeout: 5000, maxBuffer: 4096 });
  if (!/^ActiveState=[a-z-]+\n$/.test(stdout)) throw new Error(`Invalid state for ${unit}`);
  return stdout.trim().slice("ActiveState=".length);
}

async function assertPausedHealth() {
  return waitForAdmissionDrain({ probes: localReleaseHealthProbes({ oauthPort: 8789 }), timeoutMs: 15000 });
}

// No CLI: this is called only by the journaled first-migration orchestrator after
// managed unit installation and before reopening any dedicated ingress.
export async function activateManagedRelease({ journalPath, marker = PERSISTENT_MARKER,
  unitDirectory = "/etc/systemd/system", releaseRoot, versionDir, artifactSha256,
  permit = WRITER_START_PERMIT,
  inspectManaged = inspectInstalledManagedUnits, assertWritersStopped = assertBridgeWritersStopped,
  getState = systemctlState, pause = pauseAdmission, startUnit = systemctlStart,
  stopUnit = systemctlStop, assertHealthy = assertPausedHealth,
  switchPointer = switchVersion, withPermit = withWriterStartPermit } = {}) {
  if (process.getuid?.() !== 0 || !path.isAbsolute(releaseRoot || "") ||
      !/^[0-9a-f]{64}$/.test(artifactSha256 || "")) {
    throw new Error("Root, release root and exact signed artifact digest are required");
  }
  const journal = await readMigrationJournal(journalPath);
  if (journal.phase !== "switched" || artifactSha256 !== journal.artifactSha256 ||
      typeof versionDir !== "string" || !versionDir.endsWith(`-${journal.newCommit}`)) {
    throw new Error("Candidate release does not match journaled switch intent");
  }
  await verifyJournalUnitBackup(journal);
  await verifyJournalStateBundle(journal);
  await verifyMarker(marker);
  await assertWriterPermitAbsent(permit);
  await assertWritersStopped();
  for (const unit of INGRESS) {
    if (await getState(unit) !== "inactive") throw new Error(`Ingress remains active: ${unit}`);
  }
  await inspectManaged({ unitDirectory, releaseRoot, marker, permit });
  await pause();
  const started = [];
  let result;
  try {
    result = await switchPointer({ releaseRoot, versionDir, checkHealthy: async () =>
      withPermit({ marker, permit, action: async () => {
        for (const unit of START_ORDER) {
          // Track before start: a failed systemctl start may still leave a live process.
          started.push(unit);
          await startUnit(unit);
        }
        await assertHealthy();
      } }) });
  } catch (error) {
    const stopFailures = [];
    for (const unit of started.reverse()) {
      try { await stopUnit(unit); }
      catch (stopError) { stopFailures.push(stopError); }
    }
    if (stopFailures.length) {
      throw new AggregateError([error, ...stopFailures], "Candidate activation and stop failed; ingress remains closed");
    }
    throw error;
  }
  await advanceMigrationJournal(journalPath, "switched", "locally-healthy");
  return { current: result.current, previous: result.previous, services: [...START_ORDER], admission: "paused" };
}

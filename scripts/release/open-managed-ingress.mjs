import { execFile } from "node:child_process";
import { lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resumeAdmission, verifyAdmissionPause } from "./admission-pause.mjs";
import { createPersistentMarker, removePersistentMarker } from "./close-legacy-ingress.mjs";
import { PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";
import { inspectInstalledIngressGuard } from "./installed-ingress-guard-preflight.mjs";
import { inspectInstalledManagedUnits } from "./installed-managed-unit-preflight.mjs";
import { advanceMigrationJournal, readMigrationJournal, verifyJournalUnitBackup } from "./migration-journal.mjs";
import { verifyMarker } from "./quiesce-legacy-writers.mjs";
import { verifyJournalStateBundle } from "./snapshot-legacy-state.mjs";
import { localReleaseHealthProbes, waitForAdmissionDrain } from "./wait-admission-drain.mjs";
import { DEFAULT_ADMISSION_PAUSE_PATH } from "../../packages/core/src/admission-gate.js";
import { probePublicOAuthPaused } from "./public-admission-probe.mjs";
import { assertWriterPermitAbsent } from "./writer-start-permit.mjs";
import { WRITER_START_PERMIT } from "./writer-boot-guard.mjs";

const exec = promisify(execFile);
const INGRESS = ["dp-beget-oauth-proxy.socket", "dp-beget-oauth-proxy.service", "dp-beget-tunnel.service"];
const START = ["dp-beget-oauth-proxy.socket", "dp-beget-tunnel.service"];

async function systemctl(unit, action) {
  await exec("systemctl", [action, unit], { timeout: 20000, maxBuffer: 4096 });
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

// The caller must independently prove the *exclusive* public hostname route and
// observe a real non-health public request denied by the R0004 admission gate.
// This function has no CLI and cannot infer either claim from local health alone.
export async function openManagedIngress({ journalPath, marker = PERSISTENT_MARKER,
  permit = WRITER_START_PERMIT,
  admissionFlag = DEFAULT_ADMISSION_PAUSE_PATH, unitDirectory = "/etc/systemd/system",
  releaseRoot, versionDir, artifactSha256, assertRouteExclusive,
  assertPublicPaused = probePublicOAuthPaused,
  inspectGuard = inspectInstalledIngressGuard, inspectManaged = inspectInstalledManagedUnits,
  assertLocalPaused = assertPausedHealth, getState = systemctlState,
  startUnit = unit => systemctl(unit, "start"), stopUnit = unit => systemctl(unit, "stop"),
  removeMarker = removePersistentMarker, restoreMarker = createPersistentMarker,
  resume = resumeAdmission } = {}) {
  if (process.getuid?.() !== 0 || typeof assertRouteExclusive !== "function" ||
      typeof assertPublicPaused !== "function" || !path.isAbsolute(admissionFlag) ||
      !path.isAbsolute(releaseRoot || "") || !/^[0-9a-f]{64}$/.test(artifactSha256 || "")) {
    throw new Error("Root, exact candidate identity, admission flag and explicit route/public proofs are required");
  }
  const journal = await readMigrationJournal(journalPath);
  if (journal.phase !== "locally-healthy" || artifactSha256 !== journal.artifactSha256 ||
      typeof versionDir !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?-[0-9a-f]{40}$/.test(versionDir) ||
      !versionDir.endsWith(`-${journal.newCommit}`)) {
    throw new Error("Locally healthy journal and exact candidate identity are required");
  }
  await verifyJournalUnitBackup(journal);
  await verifyJournalStateBundle(journal);
  await verifyMarker(marker);
  await assertWriterPermitAbsent(permit);
  await verifyAdmissionPause({ flag: admissionFlag });
  if ((await realpath(releaseRoot)) !== releaseRoot ||
      (await realpath(path.join(releaseRoot, "releases"))) !== path.join(releaseRoot, "releases") ||
      (await readlink(path.join(releaseRoot, "current"))) !== `releases/${versionDir}`) {
    throw new Error("Active candidate pointer does not match the migration journal");
  }
  try { await lstat(path.join(releaseRoot, ".activation.lock"));
    throw new Error("Unresolved candidate activation lock");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await inspectGuard({ unitDirectory, marker });
  await inspectManaged({ unitDirectory, releaseRoot, marker, permit });
  for (const unit of INGRESS) {
    if (await getState(unit) !== "inactive") throw new Error(`Ingress already active: ${unit}`);
  }
  await assertLocalPaused();
  if (await assertRouteExclusive() !== true) throw new Error("Exclusive public OAuth route not proven");

  // Record possible exposure before allowing the boot guard to clear. From this
  // point, recovery must not silently rewind the grouped state snapshot.
  await advanceMigrationJournal(journalPath, "locally-healthy", "ingress-open");
  try {
    await removeMarker(marker);
    for (const unit of START) await startUnit(unit);
    for (const unit of START) {
      if (await getState(unit) !== "active") throw new Error(`Dedicated ingress did not start: ${unit}`);
    }
    if (await assertPublicPaused() !== true) throw new Error("Public admission denial not proven");
    await assertLocalPaused();
    await verifyAdmissionPause({ flag: admissionFlag });
    if (await assertRouteExclusive() !== true) throw new Error("Exclusive public OAuth route changed");
  } catch (error) {
    const failures = [];
    // Reinstall the boot guard first: a restart during failed cleanup must keep
    // the dedicated socket and tunnel closed.
    try {
      try { await lstat(marker); await verifyMarker(marker); }
      catch (markerError) {
        if (markerError.code !== "ENOENT") throw markerError;
        await restoreMarker(marker);
      }
    } catch (markerError) { failures.push(markerError); }
    for (const unit of INGRESS) {
      try { await stopUnit(unit); }
      catch (stopError) { failures.push(stopError); }
    }
    if (failures.length) throw new AggregateError([error, ...failures], "Ingress release and safe closure failed");
    throw error;
  }

  // An error here may follow removal of the pause flag. Leave the ingress-open
  // journal intact and require inspection; never restore old state automatically.
  await resume({ flag: admissionFlag, assertHealthy: async () => {
    await assertLocalPaused();
    if (await assertRouteExclusive() !== true || await assertPublicPaused() !== true) {
      throw new Error("Public route or admission denial changed before resume");
    }
  } });
  await advanceMigrationJournal(journalPath, "ingress-open", "completed");
  return { phase: "completed", ingress: [...START], admission: "open" };
}

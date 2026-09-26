import path from "node:path";
import { activateManagedRelease } from "./activate-managed-release.mjs";
import { closeLegacyIngress } from "./close-legacy-ingress.mjs";
import { installManagedOverrides } from "./install-managed-overrides.mjs";
import { installMigrationBootGuards } from "./install-migration-boot-guards.mjs";
import { readMigrationJournal, verifyJournalUnitBackup } from "./migration-journal.mjs";
import { openManagedIngress } from "./open-managed-ingress.mjs";
import { preflightBegetLegacyRoute } from "./preflight-beget-legacy-route.mjs";
import { promotePreparedRelease } from "./promote-prepared-release.mjs";
import { quiesceLegacyWriters } from "./quiesce-legacy-writers.mjs";
import { snapshotLegacyState } from "./snapshot-legacy-state.mjs";

const DATABASES = Object.freeze([
  ["dp-beget-session-host.service", "session-host", "/var/lib/dp-beget-bridge/state.sqlite"],
  ["dp-beget-agent.service", "agent", "/var/lib/dp-beget-bridge-agent/session-owners.sqlite"],
  ["dp-beget-mcp-oauth-spike.service", "oauth", "/var/lib/dp-beget-bridge-mcp/auth/auth.sqlite"]
]);
function absolute(value) {
  return typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value;
}

function boundDatabases(report) {
  const entries = report?.bindings?.databases;
  if (!Array.isArray(entries) || entries.length !== DATABASES.length ||
      DATABASES.some(([unit, , database], index) => entries[index]?.unit !== unit ||
        entries[index]?.database !== database || !Number.isSafeInteger(entries[index]?.size) ||
        entries[index].size < 0)) {
    throw new Error("Live R0003 database bindings do not match the migration inventory");
  }
  return DATABASES.map(([, name, source]) => ({ name, source }));
}

// Library entry point only. A production caller must supply independently
// implemented exclusive-route and bounded R0003 drain proofs. This does not
// install itself, resume an interrupted journal, or auto-rewind user state.
export async function runFirstMigration({ journalPath, workspace, releaseRoot, trustDir,
  stagedIngress, stagedWriters, stagedManaged, unitDirectory = "/etc/systemd/system",
  marker, permit, configRoot, snapshotDir, assertRouteExclusive, assertNoInFlight,
  preflight = preflightBegetLegacyRoute, promote = promotePreparedRelease,
  installGuards = installMigrationBootGuards, closeIngress = closeLegacyIngress,
  quiesce = quiesceLegacyWriters, snapshot = snapshotLegacyState,
  installManaged = installManagedOverrides, activate = activateManagedRelease,
  openIngress = openManagedIngress } = {}) {
  if (process.getuid?.() !== 0 || typeof assertRouteExclusive !== "function" ||
      typeof assertNoInFlight !== "function" ||
      [journalPath, workspace, releaseRoot, stagedIngress, stagedWriters, stagedManaged,
        unitDirectory, configRoot, snapshotDir].some(value => !absolute(value))) {
    throw new Error("Root, absolute migration paths and independent ingress/drain proofs are required");
  }
  const journal = await readMigrationJournal(journalPath);
  if (journal.phase !== "prepared") throw new Error("Migration needs a fresh prepared journal; inspect recovery first");
  await verifyJournalUnitBackup(journal);
  const promoted = await promote({ workspace, releaseRoot, trustDir });
  if (promoted?.sha256 !== journal.artifactSha256 ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?-[0-9a-f]{40}$/.test(promoted.versionDir) ||
      !promoted.versionDir.endsWith(`-${journal.newCommit}`) ||
      promoted.directory !== path.join(releaseRoot, "releases", promoted.versionDir)) {
    throw new Error("Promoted signed release differs from the prepared migration journal");
  }
  // Inspect live data after promotion; preparing dependencies may take time.
  // This observation does not replace the separate ingress and drain proofs.
  const databases = boundDatabases(await preflight());
  const proveDrain = async () => {
    if (await assertNoInFlight() !== true) {
      throw new Error("Independent R0003 in-flight drain proof did not succeed");
    }
  };
  const common = { journalPath, unitDirectory, marker, permit };
  const steps = [
    ["guarded", () => installGuards({ ...common, stagedIngress, stagedWriters })],
    ["ingress-closed", () => closeIngress({ ...common, assertRouteExclusive })],
    ["quiesced", () => quiesce({ ...common, stateDatabase: databases[0].source,
      assertNoInFlight: proveDrain })],
    ["snapshotted", () => snapshot({ ...common, configRoot, databases, outputDir: snapshotDir })],
    ["switched", () => installManaged({ ...common, stagedDirectory: stagedManaged, releaseRoot })],
    ["locally-healthy", () => activate({ ...common, releaseRoot,
      versionDir: promoted.versionDir, artifactSha256: promoted.sha256 })],
    ["completed", () => openIngress({ ...common, releaseRoot,
      versionDir: promoted.versionDir, artifactSha256: promoted.sha256, assertRouteExclusive })]
  ];
  for (const [phase, action] of steps) {
    await action();
    const now = await readMigrationJournal(journalPath);
    if (now.transactionId !== journal.transactionId || now.phase !== phase ||
        now.oldCommit !== journal.oldCommit || now.newCommit !== journal.newCommit ||
        now.artifactSha256 !== journal.artifactSha256) {
      throw new Error(`Migration stopped: ${phase} was not journaled under the prepared transaction`);
    }
  }
  return { transactionId: journal.transactionId, phase: "completed",
    versionDir: promoted.versionDir };
}

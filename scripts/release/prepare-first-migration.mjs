import path from "node:path";
import { lstat } from "node:fs/promises";
import { backupSystemdUnits } from "./backup-systemd-units.mjs";
import { stageIngressBootGuard, PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";
import { boundDatabases } from "./legacy-bound-databases.mjs";
import { inspectLegacyServiceActivity } from "./legacy-service-activity.mjs";
import { readMigrationJournal, startMigrationJournal } from "./migration-journal.mjs";
import { preflightBegetLegacyRoute } from "./preflight-beget-legacy-route.mjs";
import { prepareRelease } from "./prepare-release.mjs";
import { stageManagedUnitOverrides } from "./stage-managed-unit-overrides.mjs";
import { stageWriterBootGuard, WRITER_START_PERMIT } from "./writer-boot-guard.mjs";

function absolute(value) {
  return typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value;
}

function overlaps(left, right) {
  return left === right || left.startsWith(`${right}${path.sep}`) ||
    right.startsWith(`${left}${path.sep}`);
}

// Only prepares private, inert files and a fresh journal. The forward transaction
// separately rechecks the live bindings and demands independent ingress/drain proofs.
// No CLI: the caller must explicitly identify and verify the installed old commit.
export async function prepareFirstMigration({ artifact, manifest, signature, workspace,
  snapshotParent, releaseRoot, unitBackupDir, stagedIngress, stagedWriters, stagedManaged,
  journalPath, oldCommit, trustDir, marker = PERSISTENT_MARKER,
  permit = WRITER_START_PERMIT, unitDirectory = "/etc/systemd/system",
  preflight = preflightBegetLegacyRoute, prepare = prepareRelease,
  backup = backupSystemdUnits, stageIngress = stageIngressBootGuard,
  stageWriters = stageWriterBootGuard, stageManaged = stageManagedUnitOverrides,
  inspectServices = inspectLegacyServiceActivity } = {}) {
  const outputs = [workspace, unitBackupDir, stagedIngress, stagedWriters, stagedManaged,
    journalPath];
  if (process.getuid?.() !== 0 || !/^[0-9a-f]{40}$/.test(oldCommit || "") ||
      [...outputs, snapshotParent, releaseRoot, unitDirectory, marker, permit,
        artifact, manifest, signature].some(value => !absolute(value)) ||
      outputs.some((value, i) => outputs.slice(i + 1).some(other => overlaps(value, other))) ||
      outputs.some(value => snapshotParent === value ||
        snapshotParent.startsWith(`${value}${path.sep}`)) ||
      outputs.some(value => [releaseRoot, unitDirectory, marker, permit]
        .some(other => overlaps(value, other)))) {
    throw new Error("Root, a verified old commit and distinct absolute private migration paths are required");
  }
  // A pre-existing journal must never be mistaken for a fresh preparation.
  try {
    await lstat(journalPath);
    throw new Error("A migration journal already exists; inspect its phase before continuing");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const databases = boundDatabases(await preflight());
  const candidate = await prepare({ artifact, manifest, signature, workspace, trustDir,
    migration: { snapshotParent, databases } });
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(candidate?.version) ||
      !/^[0-9a-f]{40}$/.test(candidate?.commit || "") || candidate.commit === oldCommit ||
      !/^[0-9a-f]{64}$/.test(candidate?.sha256 || "") ||
      candidate.directory !== path.join(workspace, "extracted", `dp-beget-bridge-${candidate.version}`)) {
    throw new Error("Prepared signed release identity is invalid");
  }
  await backup({ outputDir: unitBackupDir, unitDirectory });
  await stageIngress({ outputDir: stagedIngress, marker });
  await stageWriters({ outputDir: stagedWriters, marker, permit });
  await stageManaged({ outputDir: stagedManaged, releaseRoot });
  const journal = await startMigrationJournal(journalPath, {
    oldCommit, newCommit: candidate.commit, artifactSha256: candidate.sha256,
    unitBackupDir, inspectServices });
  const readBack = await readMigrationJournal(journalPath);
  if (readBack.transactionId !== journal.transactionId || readBack.phase !== "prepared") {
    throw new Error("Prepared migration journal could not be read back");
  }
  return { transactionId: journal.transactionId, phase: "prepared", journalPath,
    workspace, unitBackupDir, stagedIngress, stagedWriters, stagedManaged,
    newCommit: candidate.commit, artifactSha256: candidate.sha256 };
}

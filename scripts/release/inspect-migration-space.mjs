import { stat } from "node:fs/promises";
import path from "node:path";
import { inspectReleasePreparationSpace } from "./inspect-release-preparation-space.mjs";
import { inspectStateBundleSpace } from "./inspect-state-bundle-space.mjs";

// Before the first migration, require headroom for both independent phases
// on Beget's shared volume. Adding the two budgets counts the 512 MiB free
// reserve twice on purpose; npm working space is still an estimate.
export async function inspectMigrationSpace({ workspaceParent, snapshotParent, archiveBytes,
  databases, inspectParent = stat, inspectPreparation = inspectReleasePreparationSpace,
  inspectSnapshot = inspectStateBundleSpace } = {}) {
  if (!path.isAbsolute(workspaceParent || "") || !path.isAbsolute(snapshotParent || "")) {
    throw new Error("Absolute release and snapshot parent directories are required");
  }
  const [workspace, snapshot] = await Promise.all([
    inspectParent(workspaceParent), inspectParent(snapshotParent)
  ]);
  if (!workspace.isDirectory() || !snapshot.isDirectory() ||
      !Number.isSafeInteger(workspace.dev) || workspace.dev !== snapshot.dev) {
    throw new Error("Release and snapshot must use the same known filesystem for combined capacity");
  }
  const preparation = await inspectPreparation({ parent: workspaceParent, archiveBytes });
  const state = await inspectSnapshot({ parent: snapshotParent, databases });
  const availableBytes = preparation.availableBytes < state.availableBytes
    ? preparation.availableBytes : state.availableBytes;
  const requiredBytes = preparation.requiredBytes + state.requiredBytes;
  if (availableBytes < requiredBytes) {
    throw new Error("Insufficient combined free space for release preparation and migration recovery");
  }
  return { availableBytes, requiredBytes, databaseBytes: state.databaseBytes,
    journalBytes: state.journalBytes,
    scope: "shared-volume preparation and grouped snapshot allowances; npm usage remains estimated" };
}

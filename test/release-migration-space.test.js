import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectMigrationSpace } from "../scripts/release/inspect-migration-space.mjs";
import { inspectReleasePreparationSpace } from "../scripts/release/inspect-release-preparation-space.mjs";
import { inspectStateBundleSpace } from "../scripts/release/inspect-state-bundle-space.mjs";

test("OPS-06: shared-volume guard rejects combined pressure even when each phase passes", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-migration-space-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspaceParent = path.join(root, "release");
  const snapshotParent = path.join(root, "snapshot");
  await mkdir(workspaceParent);
  await mkdir(snapshotParent);
  const source = path.join(root, "state.sqlite");
  await writeFile(source, Buffer.alloc(4096));
  await writeFile(`${source}-wal`, Buffer.alloc(8192));
  const databases = [{ name: "state", source }];
  const archiveBytes = 128;
  const unlimited = async () => ({ bavail: 16n * 1024n * 1024n * 1024n, bsize: 1n });
  const prep = await inspectReleasePreparationSpace({ parent: workspaceParent, archiveBytes,
    inspectFilesystem: unlimited });
  const state = await inspectStateBundleSpace({ parent: snapshotParent, databases,
    inspectFilesystem: unlimited });
  const freeBytes = prep.requiredBytes + 128n * 1024n * 1024n;
  assert.ok(freeBytes > state.requiredBytes);
  const capacity = async () => ({ bavail: freeBytes, bsize: 1n });
  const options = { workspaceParent, snapshotParent, archiveBytes, databases,
    inspectPreparation: args => inspectReleasePreparationSpace({ ...args, inspectFilesystem: capacity }),
    inspectSnapshot: args => inspectStateBundleSpace({ ...args, inspectFilesystem: capacity }) };
  await assert.rejects(inspectMigrationSpace(options), /Insufficient combined free space/);
  const result = await inspectMigrationSpace({ ...options,
    inspectPreparation: args => inspectReleasePreparationSpace({ ...args, inspectFilesystem: unlimited }),
    inspectSnapshot: args => inspectStateBundleSpace({ ...args, inspectFilesystem: unlimited }) });
  assert.equal(result.requiredBytes, prep.requiredBytes + state.requiredBytes);
  assert.equal(result.journalBytes, 8192n);
  await assert.rejects(inspectMigrationSpace({ ...options,
    inspectParent: async parent => {
      const info = await stat(parent);
      return { isDirectory: () => info.isDirectory(),
        dev: info.dev + Number(parent === snapshotParent) };
    } }), /same known filesystem/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { backupStateBundle } from "../scripts/release/backup-state-bundle.mjs";
import { inspectRecoveryDestinations } from "../scripts/release/inspect-recovery-destinations.mjs";
import { restoreStateBundle } from "../scripts/release/restore-state-bundle.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-recovery-destinations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configRoot = path.join(root, "config");
  await mkdir(configRoot, { mode: 0o700 });
  await writeFile(path.join(configRoot, "agent.env"), "PRIVATE=canary\n", { mode: 0o600 });
  const state = path.join(root, "state");
  await mkdir(state, { mode: 0o700 });
  const source = path.join(state, "agent.sqlite");
  const db = new DatabaseSync(source);
  db.exec("CREATE TABLE state (value TEXT)");
  db.close();
  await chmod(source, 0o600);
  const snapshot = path.join(root, "snapshot");
  await backupStateBundle({ configRoot, databases: [{ name: "agent", source }],
    outputDir: snapshot, assertQuiesced: async () => {} });
  const stagedDirectory = path.join(root, "staged");
  const restored = await restoreStateBundle({ backupDir: snapshot, outputDir: stagedDirectory });
  return { root, configRoot, source, stagedDirectory, sources: restored.sources,
    databases: restored.databases };
}

test("OPS-07: recovery preflight accepts exact source paths and unchanged destination topology", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  const result = await inspectRecoveryDestinations(options);
  assert.equal(result.configRoot, options.configRoot);
  assert.equal(result.configIno, (await stat(options.configRoot)).ino);
  assert.equal(result.databases[0].ino, (await stat(options.source)).ino);
});

test("OPS-07: recovery preflight rejects a SQLite WAL sidecar", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await writeFile(`${options.source}-wal`, "pending transactions\n");
  await assert.rejects(inspectRecoveryDestinations(options), /sidecar needs explicit recovery/);
});

test("OPS-07: recovery preflight rejects changed config inventory and database permissions", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await writeFile(path.join(options.configRoot, "candidate.env"), "NEW=1\n");
  await assert.rejects(inspectRecoveryDestinations(options), /configuration inventory differs/);
  await rm(path.join(options.configRoot, "candidate.env"));
  await chmod(options.source, 0o644);
  await assert.rejects(inspectRecoveryDestinations(options), /SQLite destination ownership or mode changed/);
});

test("OPS-07: recovery preflight rejects redirected and overlapping destinations", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await assert.rejects(inspectRecoveryDestinations({ ...options,
    sources: { ...options.sources, databases: [{ name: "agent", path: path.join(options.configRoot, "agent.env") }] } }),
  /Overlapping or invalid/);
  await rm(options.source);
  await symlink(path.join(options.stagedDirectory, "sqlite", "agent.sqlite"), options.source);
  await assert.rejects(inspectRecoveryDestinations(options), /Untrusted recovery destination file/);
});

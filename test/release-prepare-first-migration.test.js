import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { readMigrationJournal } from "../scripts/release/migration-journal.mjs";
import { prepareFirstMigration } from "../scripts/release/prepare-first-migration.mjs";
import { legacyActivityFixture, unitBackupFixture } from "./fixtures/unit-backup.js";

const oldCommit = "a".repeat(40);
const newCommit = "b".repeat(40);
const digest = "c".repeat(64);
const sources = [
  { unit: "dp-beget-session-host.service", database: "/var/lib/dp-beget-bridge/state.sqlite", size: 12 },
  { unit: "dp-beget-agent.service", database: "/var/lib/dp-beget-bridge-agent/session-owners.sqlite", size: 8 },
  { unit: "dp-beget-mcp-oauth-spike.service", database: "/var/lib/dp-beget-bridge-mcp/auth/auth.sqlite", size: 16 }
];

async function setup(t) {
  const fixture = await unitBackupFixture(t);
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-first-preparation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseRoot = path.join(root, "release-root");
  await mkdir(releaseRoot, { mode: 0o700 });
  const options = { oldCommit, artifact: path.join(root, "artifact.tar"),
    manifest: path.join(root, "manifest.json"), signature: path.join(root, "signature"),
    workspace: path.join(root, "workspace"), snapshotParent: root, releaseRoot,
    unitBackupDir: path.join(root, "units"), stagedIngress: path.join(root, "ingress"),
    stagedWriters: path.join(root, "writers"), stagedManaged: path.join(root, "managed"),
    journalPath: path.join(root, "transaction.json"),
    marker: `/var/lib/dp-r0004-test-${path.basename(root)}/migration-incomplete`,
    permit: "/run/dp-beget-test/writer-start-allowed", unitDirectory: "/etc/systemd/system",
    preflight: async () => ({ bindings: { databases: sources } }),
    inspectServices: legacyActivityFixture,
    backup: async ({ outputDir }) => cp(fixture.backupDir, outputDir, { recursive: true }),
    prepare: async ({ workspace, migration }) => {
      assert.equal(migration.snapshotParent, root);
      assert.deepEqual(migration.databases, [
        { name: "session-host", source: sources[0].database },
        { name: "agent", source: sources[1].database },
        { name: "oauth", source: sources[2].database }
      ]);
      return { version: "0.1.0", commit: newCommit, sha256: digest,
        directory: path.join(workspace, "extracted", "dp-beget-bridge-0.1.0") };
    }
  };
  return options;
}

test("preparation pins all live databases, stages inert files and journals the signed identity", {
  skip: process.getuid?.() !== 0
}, async t => {
  const args = await setup(t);
  const result = await prepareFirstMigration(args);
  const journal = await readMigrationJournal(args.journalPath);
  assert.equal(journal.transactionId, result.transactionId);
  assert.equal(journal.phase, "prepared");
  assert.equal(journal.unitBackup.path, args.unitBackupDir);
  assert.equal(journal.newCommit, newCommit);
  assert.equal(journal.artifactSha256, digest);
  assert.equal((await stat(args.stagedIngress)).isDirectory(), true);
  assert.equal((await stat(args.stagedWriters)).isDirectory(), true);
  assert.equal((await stat(args.stagedManaged)).isDirectory(), true);
  await assert.rejects(prepareFirstMigration(args), /journal already exists/);
});

test("preparation refuses changed live SQLite bindings before staging an artifact", {
  skip: process.getuid?.() !== 0
}, async t => {
  const args = await setup(t);
  let prepared = false;
  await assert.rejects(prepareFirstMigration({ ...args, preflight: async () => ({ bindings: {
    databases: [sources[0], sources[1], { ...sources[2], database: "/tmp/other.sqlite" }]
  } }), prepare: async () => { prepared = true; } }), /database bindings/);
  assert.equal(prepared, false);
  await assert.rejects(stat(args.journalPath), { code: "ENOENT" });
});

test("preparation rejects a candidate identity mismatch before backing up units", {
  skip: process.getuid?.() !== 0
}, async t => {
  const args = await setup(t);
  let backedUp = false;
  await assert.rejects(prepareFirstMigration({ ...args,
    prepare: async () => ({ version: "0.1.0", commit: oldCommit, sha256: digest,
      directory: path.join(args.workspace, "extracted", "dp-beget-bridge-0.1.0") }),
    backup: async () => { backedUp = true; }
  }), /signed release identity/);
  assert.equal(backedUp, false);
  await assert.rejects(stat(args.journalPath), { code: "ENOENT" });
});

test("a staging failure leaves no prepared journal or installed guard", {
  skip: process.getuid?.() !== 0
}, async t => {
  const args = await setup(t);
  await assert.rejects(prepareFirstMigration({ ...args, stageManaged: async () => {
    throw new Error("staging stopped");
  } }), /staging stopped/);
  await assert.rejects(stat(args.journalPath), { code: "ENOENT" });
  await assert.rejects(stat(args.marker), { code: "ENOENT" });
  assert.equal((await stat(args.stagedIngress)).isDirectory(), true);
});

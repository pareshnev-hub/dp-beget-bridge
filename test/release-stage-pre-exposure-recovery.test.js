import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { backupStateBundle } from "../scripts/release/backup-state-bundle.mjs";
import { preparePreExposureRollback, readPreparedRollbackIntent, verifyPreparedRollbackIntent } from
  "../scripts/release/prepare-pre-exposure-rollback.mjs";
import { stageCompletePreExposureRecovery } from "../scripts/release/stage-complete-pre-exposure-recovery.mjs";
import { advanceMigrationJournal, startMigrationJournal } from "../scripts/release/migration-journal.mjs";
import { stagePreExposureRecovery } from "../scripts/release/stage-pre-exposure-recovery.mjs";
import { verifyStagedRecoveryPair } from "../scripts/release/verify-staged-recovery-pair.mjs";
import { legacyActivityFixture, unitBackupFixture } from "./fixtures/unit-backup.js";

async function fixture(t, phase = "locally-healthy") {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-stage-recovery-"));
  const markerRoot = await mkdtemp("/var/lib/dp-stage-recovery-");
  const permitRoot = await mkdtemp("/run/dp-stage-recovery-");
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(markerRoot, { recursive: true, force: true }));
  t.after(() => rm(permitRoot, { recursive: true, force: true }));
  const marker = path.join(markerRoot, "migration-incomplete");
  await writeFile(marker, "dp-beget-bridge-migration-incomplete-v1\n", { mode: 0o600 });
  const configRoot = path.join(root, "config");
  await mkdir(configRoot, { mode: 0o700 });
  await writeFile(path.join(configRoot, "secret.env"), "CANARY=private\n", { mode: 0o600 });
  const database = path.join(root, "legacy.sqlite");
  const db = new DatabaseSync(database);
  db.exec("CREATE TABLE state (value TEXT)");
  db.prepare("INSERT INTO state VALUES (?)").run("old-state");
  db.close();
  const snapshotPath = path.join(root, "snapshot");
  await backupStateBundle({ configRoot, databases: [{ name: "legacy", source: database }],
    outputDir: snapshotPath, assertQuiesced: async () => {} });
  const snapshotSha256 = createHash("sha256").update(await readFile(path.join(snapshotPath,
    "bundle-manifest.json"))).digest("hex");
  const { backupDir } = await unitBackupFixture(t);
  const journalPath = path.join(root, "journal.json");
  await startMigrationJournal(journalPath, { oldCommit: "a".repeat(40), newCommit: "b".repeat(40),
    artifactSha256: "c".repeat(64), unitBackupDir: backupDir, inspectServices: legacyActivityFixture });
  for (const [before, after] of [["prepared", "guarded"], ["guarded", "ingress-closed"],
    ["ingress-closed", "quiesced"]]) await advanceMigrationJournal(journalPath, before, after);
  await advanceMigrationJournal(journalPath, "quiesced", "snapshotted", { snapshotPath, snapshotSha256 });
  if (["switched", "locally-healthy", "ingress-open"].includes(phase)) {
    await advanceMigrationJournal(journalPath, "snapshotted", "switched");
  }
  if (["locally-healthy", "ingress-open"].includes(phase)) {
    await advanceMigrationJournal(journalPath, "switched", "locally-healthy");
  }
  if (phase === "ingress-open") await advanceMigrationJournal(journalPath, "locally-healthy", "ingress-open");
  return { journalPath, marker, snapshotPath, configRoot, database, outputDir: path.join(root, "restored"),
    permit: path.join(permitRoot, "writer-start-allowed"),
    inspectGuard: async () => {}, inspectWriterGuards: async () => {},
    getState: async () => "inactive", assertRouteExclusive: async () => true };
}

test("OPS-07: pre-exposure staging verifies real grouped state without changing live data", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  const result = await stagePreExposureRecovery(options);
  assert.deepEqual(result.databases, ["legacy"]);
  assert.equal(result.sources.databases[0].name, "legacy");
  assert.equal(path.isAbsolute(result.sources.databases[0].path), true);
  assert.equal(await readFile(path.join(options.outputDir, "config", "secret.env"), "utf8"), "CANARY=private\n");
  const db = new DatabaseSync(path.join(options.outputDir, "sqlite", "legacy.sqlite"), { readOnly: true });
  try { assert.equal(db.prepare("SELECT value FROM state").get().value, "old-state"); }
  finally { db.close(); }
  assert.match(await readFile(options.marker, "utf8"), /migration-incomplete/);
});

test("OPS-07: exposure intent forbids old-state staging even if marker was recreated", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t, "ingress-open");
  await assert.rejects(stagePreExposureRecovery(options), /rewind is forbidden/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: route failure and changed ingress state block recovery before copying", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await assert.rejects(stagePreExposureRecovery({ ...options, assertRouteExclusive: async () => false }),
    /route not proven/);
  await assert.rejects(stagePreExposureRecovery({ ...options, getState: async () => "active" }),
    /Ingress remains active/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: a route change after copying removes staged state", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  let calls = 0;
  await assert.rejects(stagePreExposureRecovery({ ...options,
    assertRouteExclusive: async () => ++calls === 1 }), /route not proven/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: recovery staging requires writer boot guards in the journaled unit phase", {
  skip: process.getuid?.() !== 0
}, async t => {
  for (const [phase, managed] of [["snapshotted", false], ["switched", true], ["locally-healthy", true]]) {
    const options = await fixture(t, phase);
    let checks = 0;
    await stagePreExposureRecovery({ ...options,
      inspectWriterGuards: async args => { assert.equal(args.managed, managed); checks++; } });
    assert.equal(checks, 2);
  }
});

test("OPS-07: missing writer guard or leftover permit blocks recovery before copy", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await assert.rejects(stagePreExposureRecovery({ ...options,
    inspectWriterGuards: async () => { throw new Error("writer guard not loaded"); } }),
  /writer guard not loaded/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
  await writeFile(options.permit, "unexpected permit\n");
  await assert.rejects(stagePreExposureRecovery(options), /permit remains active/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: writer guard change after copy removes staged state", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  let checks = 0;
  await assert.rejects(stagePreExposureRecovery({ ...options,
    inspectWriterGuards: async () => {
      if (++checks === 2) throw new Error("writer guard changed");
    } }), /writer guard changed/);
  assert.equal(checks, 2);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: permit appearing during recovery removes staged state", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await assert.rejects(stagePreExposureRecovery({ ...options,
    restore: async args => {
      const { restoreStateBundle } = await import("../scripts/release/restore-state-bundle.mjs");
      const result = await restoreStateBundle(args);
      await writeFile(options.permit, "unexpected permit\n");
      return result;
    } }), /permit remains active/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: stages matching old state and original systemd units together", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  const result = await stageCompletePreExposureRecovery(options);
  assert.equal(result.transactionId, result.state.transactionId);
  assert.equal(result.units.files, 7);
  assert.equal(result.destinations.databases[0].path, options.database);
  assert.equal(await readFile(path.join(result.directory, "state", "config", "secret.env"), "utf8"),
    "CANARY=private\n");
  assert.match(await readFile(path.join(result.directory, "units", "dp-beget-session-host.service"), "utf8"),
    /Description=dp-beget-session-host.service/);
  const reopened = await verifyStagedRecoveryPair(options);
  assert.equal(reopened.transactionId, result.transactionId);
  assert.equal(reopened.destinations.databases[0].ino, result.destinations.databases[0].ino);
});

test("OPS-07: changed staged SQLite or original unit bytes refuse later recovery", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await stageCompletePreExposureRecovery(options);
  const stagedSqlite = path.join(options.outputDir, "state", "sqlite", "legacy.sqlite");
  await writeFile(stagedSqlite, "altered database\n");
  await assert.rejects(verifyStagedRecoveryPair(options), /Staged recovery file metadata changed|Staged recovery file changed/);
  const { restoreStateBundle } = await import("../scripts/release/restore-state-bundle.mjs");
  await rm(path.join(options.outputDir, "state"), { recursive: true });
  await restoreStateBundle({ backupDir: options.snapshotPath,
    outputDir: path.join(options.outputDir, "state") });
  await writeFile(path.join(options.outputDir, "units", "dp-beget-agent.service"), "altered unit\n");
  await assert.rejects(verifyStagedRecoveryPair(options), /Staged recovery file metadata changed|Staged recovery file changed/);
});

test("OPS-07: reopened pair refuses a lost closed-ingress boundary", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await stageCompletePreExposureRecovery(options);
  await assert.rejects(verifyStagedRecoveryPair({ ...options, getState: async () => "active" }),
    /Ingress remains active/);
});

test("OPS-07: reopened pair detects an extra staged config file and route drift", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await stageCompletePreExposureRecovery(options);
  const staged = path.join(options.outputDir, "state", "config", "extra.env");
  await writeFile(staged, "UNEXPECTED=1\n");
  await assert.rejects(verifyStagedRecoveryPair(options), /Staged recovery inventory changed/);
  await rm(staged);
  let proofs = 0;
  await assert.rejects(verifyStagedRecoveryPair({ ...options,
    assertRouteExclusive: async () => ++proofs === 1 }), /route not proven/);
  assert.equal(proofs, 2);
});

test("OPS-07: durable rollback intent binds the staged pair and live destination inodes", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await stageCompletePreExposureRecovery(options);
  const planPath = path.join(path.dirname(options.outputDir), "rollback-intent.json");
  const intent = await preparePreExposureRollback({ ...options,
    stagedDirectory: options.outputDir, planPath });
  assert.equal(intent.phase, "prepared");
  assert.equal(intent.destinations.databases[0].path, options.database);
  assert.deepEqual(await verifyPreparedRollbackIntent({ ...options, planPath }), intent);
  assert.deepEqual(await readPreparedRollbackIntent(planPath), intent);
});

test("OPS-07: altered staged data invalidates a previously recorded rollback intent", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await stageCompletePreExposureRecovery(options);
  const planPath = path.join(path.dirname(options.outputDir), "rollback-intent.json");
  await preparePreExposureRollback({ ...options, stagedDirectory: options.outputDir, planPath });
  await writeFile(path.join(options.outputDir, "state", "config", "secret.env"), "tampered\n");
  await assert.rejects(verifyPreparedRollbackIntent({ ...options, planPath }),
    /Staged recovery file metadata changed|Staged recovery file changed/);
});

test("OPS-07: failed route proof cannot create intent or overwrite an existing one", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await stageCompletePreExposureRecovery(options);
  const planPath = path.join(path.dirname(options.outputDir), "rollback-intent.json");
  await assert.rejects(preparePreExposureRollback({ ...options,
    stagedDirectory: options.outputDir, planPath,
    assertRouteExclusive: async () => false }), /route not proven/);
  await assert.rejects(stat(planPath), /ENOENT/);
  await writeFile(planPath, "keep\n");
  await assert.rejects(preparePreExposureRollback({ ...options,
    stagedDirectory: options.outputDir, planPath }), /EEXIST/);
  assert.equal(await readFile(planPath, "utf8"), "keep\n");
});

test("OPS-07: a route change after both restorations removes the entire staged pair", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  let proofs = 0;
  await assert.rejects(stageCompletePreExposureRecovery({ ...options,
    assertRouteExclusive: async () => ++proofs < 3 }), /route not proven/);
  assert.equal(proofs, 3);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: failed unit restoration removes staged state as a single pair", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await assert.rejects(stageCompletePreExposureRecovery({ ...options,
    stageUnits: async () => { throw new Error("original unit backup changed"); } }),
  /original unit backup changed/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: mismatched live configuration removes the staged state and units", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await writeFile(path.join(options.configRoot, "candidate.env"), "NEW=1\n");
  await assert.rejects(stageCompletePreExposureRecovery(options), /configuration inventory differs/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: a live SQLite sidecar blocks the complete recovery pair", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await writeFile(`${options.database}-wal`, "pending changes\n");
  await assert.rejects(stageCompletePreExposureRecovery(options), /sidecar needs explicit recovery/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: possible public exposure forbids combined old-state staging", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t, "ingress-open");
  await assert.rejects(stageCompletePreExposureRecovery(options), /forbidden after possible public exposure/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

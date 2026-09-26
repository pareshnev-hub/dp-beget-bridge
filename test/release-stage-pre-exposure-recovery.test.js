import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { backupStateBundle } from "../scripts/release/backup-state-bundle.mjs";
import { advanceMigrationJournal, startMigrationJournal } from "../scripts/release/migration-journal.mjs";
import { stagePreExposureRecovery } from "../scripts/release/stage-pre-exposure-recovery.mjs";
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
  return { journalPath, marker, snapshotPath, outputDir: path.join(root, "restored"),
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

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { backupStateBundle } from "../scripts/release/backup-state-bundle.mjs";
import { inspectMigrationRecovery } from "../scripts/release/inspect-migration-recovery.mjs";
import { advanceMigrationJournal, readMigrationJournal, startMigrationJournal } from "../scripts/release/migration-journal.mjs";
import { snapshotLegacyState } from "../scripts/release/snapshot-legacy-state.mjs";
import { legacyActivityFixture, unitBackupFixture } from "./fixtures/unit-backup.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-state-journal-"));
  const markerRoot = await mkdtemp("/var/lib/dp-snapshot-test-");
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(markerRoot, { recursive: true, force: true }));
  const { backupDir } = await unitBackupFixture(t);
  const journalPath = path.join(root, "journal.json");
  const marker = path.join(markerRoot, "migration-incomplete");
  await writeFile(marker, "dp-beget-bridge-migration-incomplete-v1\n", { mode: 0o600 });
  await startMigrationJournal(journalPath, { oldCommit: "a".repeat(40), newCommit: "b".repeat(40),
    artifactSha256: "c".repeat(64), unitBackupDir: backupDir,
    inspectServices: legacyActivityFixture });
  for (const [before, after] of [["prepared", "guarded"], ["guarded", "ingress-closed"],
    ["ingress-closed", "quiesced"]]) await advanceMigrationJournal(journalPath, before, after);
  const configRoot = path.join(root, "config");
  await mkdir(configRoot, { mode: 0o700 });
  await writeFile(path.join(configRoot, "agent.env"), "PRIVATE=canary\n", { mode: 0o600 });
  const source = path.join(root, "agent.sqlite");
  const database = new DatabaseSync(source);
  database.exec("CREATE TABLE data (value TEXT)");
  database.prepare("INSERT INTO data VALUES (?)").run("canary");
  database.close();
  return { root, journalPath, marker, configRoot, databases: [{ name: "agent", source }],
    outputDir: path.join(root, "snapshot") };
}

test("OPS-07: verified grouped state is bound to the journal after stopped-writer proof", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  let checks = 0;
  const result = await snapshotLegacyState({ ...options, backupBundle: args => backupStateBundle({ ...args,
    assertQuiesced: async () => { checks++; } }) });
  assert.equal(checks, 2);
  assert.match(result.snapshotSha256, /^[0-9a-f]{64}$/);
  assert.equal((await readMigrationJournal(options.journalPath)).phase, "snapshotted");
  assert.equal((await inspectMigrationRecovery({ journalPath: options.journalPath, marker: options.marker })).state,
    "incomplete-transaction");
  await writeFile(path.join(options.outputDir, "bundle-manifest.json"), "tampered\n");
  await assert.rejects(inspectMigrationRecovery({ journalPath: options.journalPath, marker: options.marker }),
    /no longer matches/);
});

test("OPS-07: failed bundle leaves journal quiesced and ingress marker in place", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await assert.rejects(snapshotLegacyState({ ...options,
    backupBundle: async () => { throw new Error("writer restarted"); } }), /writer restarted/);
  assert.equal((await readMigrationJournal(options.journalPath)).phase, "quiesced");
  assert.match(await readFile(options.marker, "utf8"), /migration-incomplete/);
});

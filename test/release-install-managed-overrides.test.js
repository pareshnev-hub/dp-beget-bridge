import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installManagedOverrides } from "../scripts/release/install-managed-overrides.mjs";
import { advanceMigrationJournal, readMigrationJournal, startMigrationJournal } from "../scripts/release/migration-journal.mjs";
import { MANAGED_APP_UNITS, MANAGED_DROP_IN, stageManagedUnitOverrides } from
  "../scripts/release/stage-managed-unit-overrides.mjs";
import { legacyActivityFixture, unitBackupFixture } from "./fixtures/unit-backup.js";
import { WRITER_GUARD_DROP_IN, writerGuardContent } from "../scripts/release/writer-boot-guard.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-install-managed-"));
  const markerRoot = await mkdtemp("/var/lib/dp-install-managed-");
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(markerRoot, { recursive: true, force: true }));
  const { backupDir } = await unitBackupFixture(t);
  const unitDirectory = path.join(root, "units");
  await mkdir(unitDirectory);
  const manifestPath = path.join(backupDir, "backup-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const record of manifest.files) {
    await writeFile(path.join(unitDirectory, record.path),
      await readFile(path.join(backupDir, "files", record.path)));
  }
  const oauth = "dp-beget-mcp-oauth-spike.service";
  const dropinPath = `${oauth}.d/10-dp012-dcr.conf`;
  const bytes = Buffer.from("[Service]\nWorkingDirectory=/opt/dp-beget-bridge-dp012-dcr\n");
  await mkdir(path.join(backupDir, "files", `${oauth}.d`), { mode: 0o700 });
  await mkdir(path.join(unitDirectory, `${oauth}.d`));
  await writeFile(path.join(backupDir, "files", dropinPath), bytes, { mode: 0o600 });
  await writeFile(path.join(unitDirectory, dropinPath), bytes);
  for (const unit of MANAGED_APP_UNITS) {
    if (unit !== oauth) await mkdir(path.join(unitDirectory, `${unit}.d`));
    await writeFile(path.join(unitDirectory, `${unit}.d`, WRITER_GUARD_DROP_IN), writerGuardContent());
  }
  manifest.files.push({ unit: oauth, path: dropinPath, uid: 0, gid: 0, mode: 0o644,
    size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  await writeFile(manifestPath, JSON.stringify(manifest));
  const releaseRoot = path.join(root, "releases");
  await mkdir(releaseRoot);
  const stagedDirectory = path.join(root, "staged");
  await stageManagedUnitOverrides({ outputDir: stagedDirectory, releaseRoot });
  const marker = path.join(markerRoot, "migration-incomplete");
  await writeFile(marker, "dp-beget-bridge-migration-incomplete-v1\n", { mode: 0o600 });
  const journalPath = path.join(root, "journal.json");
  await startMigrationJournal(journalPath, { oldCommit: "a".repeat(40), newCommit: "b".repeat(40),
    artifactSha256: "c".repeat(64), unitBackupDir: backupDir,
    inspectServices: legacyActivityFixture });
  for (const [before, after] of [["prepared", "guarded"], ["guarded", "ingress-closed"],
    ["ingress-closed", "quiesced"]]) await advanceMigrationJournal(journalPath, before, after);
  const bundlePath = path.join(root, "snapshot");
  await mkdir(bundlePath, { mode: 0o700 });
  const bundle = Buffer.from("fixture-manifest\n");
  await writeFile(path.join(bundlePath, "bundle-manifest.json"), bundle, { mode: 0o600 });
  await advanceMigrationJournal(journalPath, "quiesced", "snapshotted", { snapshotPath: bundlePath,
    snapshotSha256: createHash("sha256").update(bundle).digest("hex") });
  return { journalPath, marker, unitDirectory, stagedDirectory, releaseRoot };
}

test("OPS-07: install app overrides only after stopped-state snapshot and keep ingress closed", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  let reloaded = false;
  const result = await installManagedOverrides({ ...options,
    inspectWriterGuards: async () => {},
    assertWritersStopped: async () => {}, getState: async () => "inactive",
    daemonReload: async () => { reloaded = true; },
    inspectInstalled: async () => {
      assert.equal(reloaded, true);
      assert.equal((await readMigrationJournal(options.journalPath)).phase, "switched");
    } });
  assert.deepEqual(result.units, MANAGED_APP_UNITS);
  for (const unit of MANAGED_APP_UNITS) {
    const file = path.join(options.unitDirectory, `${unit}.d`, MANAGED_DROP_IN);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.match(await readFile(file, "utf8"), /\/current\n$/);
  }
  assert.match(await readFile(options.marker, "utf8"), /migration-incomplete/);
});

test("OPS-07: failed daemon reload retains marker and switch intent for recovery", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await assert.rejects(installManagedOverrides({ ...options,
    inspectWriterGuards: async () => {},
    assertWritersStopped: async () => {}, getState: async () => "inactive",
    daemonReload: async () => { throw new Error("reload failed"); } }), /reload failed/);
  assert.equal((await readMigrationJournal(options.journalPath)).phase, "switched");
  assert.match(await readFile(options.marker, "utf8"), /migration-incomplete/);
});

test("OPS-07: missing writer guard blocks managed switch before journal intent", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await rm(path.join(options.unitDirectory, "dp-beget-agent.service.d", WRITER_GUARD_DROP_IN));
  await assert.rejects(installManagedOverrides({ ...options,
    inspectWriterGuards: async () => {}, assertWritersStopped: async () => {},
    getState: async () => "inactive" }), /Unexpected existing override/);
  assert.equal((await readMigrationJournal(options.journalPath)).phase, "snapshotted");
});

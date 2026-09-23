import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pauseAdmission } from "../scripts/release/admission-pause.mjs";
import { advanceMigrationJournal, readMigrationJournal, startMigrationJournal } from "../scripts/release/migration-journal.mjs";
import { openManagedIngress } from "../scripts/release/open-managed-ingress.mjs";
import { inspectMigrationRecovery } from "../scripts/release/inspect-migration-recovery.mjs";
import { legacyActivityFixture, unitBackupFixture } from "./fixtures/unit-backup.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-ingress-release-"));
  const markerRoot = await mkdtemp("/var/lib/dp-ingress-release-");
  await chmod(markerRoot, 0o755);
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(markerRoot, { recursive: true, force: true }));
  const marker = path.join(markerRoot, "migration-incomplete");
  await writeFile(marker, "dp-beget-bridge-migration-incomplete-v1\n", { mode: 0o600 });
  const admissionFlag = path.join(markerRoot, "admission", "admission-paused");
  await pauseAdmission({ flag: admissionFlag });
  const { backupDir } = await unitBackupFixture(t);
  const journalPath = path.join(root, "journal.json");
  await startMigrationJournal(journalPath, { oldCommit: "a".repeat(40), newCommit: "b".repeat(40),
    artifactSha256: "c".repeat(64), unitBackupDir: backupDir, inspectServices: legacyActivityFixture });
  for (const [before, after] of [["prepared", "guarded"], ["guarded", "ingress-closed"],
    ["ingress-closed", "quiesced"]]) await advanceMigrationJournal(journalPath, before, after);
  const snapshotPath = path.join(root, "snapshot");
  await mkdir(snapshotPath, { mode: 0o700 });
  const manifest = Buffer.from("fixture-manifest\n");
  await writeFile(path.join(snapshotPath, "bundle-manifest.json"), manifest, { mode: 0o600 });
  await advanceMigrationJournal(journalPath, "quiesced", "snapshotted", { snapshotPath,
    snapshotSha256: createHash("sha256").update(manifest).digest("hex") });
  await advanceMigrationJournal(journalPath, "snapshotted", "switched");
  await advanceMigrationJournal(journalPath, "switched", "locally-healthy");
  const releaseRoot = path.join(root, "managed");
  const versionDir = `1.0.0-${"b".repeat(40)}`;
  await mkdir(path.join(releaseRoot, "releases", versionDir), { recursive: true });
  await symlink(`releases/${versionDir}`, path.join(releaseRoot, "current"));
  const steps = [];
  const options = { journalPath, marker, admissionFlag, releaseRoot, versionDir,
    artifactSha256: "c".repeat(64),
    inspectGuard: async () => { steps.push("guard"); },
    inspectManaged: async () => { steps.push("managed"); },
    assertLocalPaused: async () => { steps.push("local-paused"); },
    getState: async () => steps.includes("start:dp-beget-oauth-proxy.socket") ? "active" : "inactive",
    assertRouteExclusive: async () => { steps.push("route"); return true; },
    assertPublicPaused: async () => { steps.push("public-paused"); return true; },
    startUnit: async unit => { steps.push(`start:${unit}`); },
    stopUnit: async unit => { steps.push(`stop:${unit}`); } };
  return { options, steps };
}

test("OPS-07: no exclusive route proof leaves marker, pause and journal untouched", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { options, steps } = await fixture(t);
  await assert.rejects(openManagedIngress({ ...options, assertRouteExclusive: undefined }), /explicit route/);
  await assert.rejects(openManagedIngress({ ...options, assertRouteExclusive: async () => false }), /not proven/);
  assert.equal((await readMigrationJournal(options.journalPath)).phase, "locally-healthy");
  assert.match(await readFile(options.marker, "utf8"), /migration-incomplete/);
  assert.match(await readFile(options.admissionFlag, "utf8"), /admission-paused/);
  assert.equal(steps.some(step => step.startsWith("start:")), false);
});

test("OPS-07: a changed active pointer blocks ingress before any route mutation", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { options, steps } = await fixture(t);
  await rm(path.join(options.releaseRoot, "current"));
  await symlink("releases/other", path.join(options.releaseRoot, "current"));
  await assert.rejects(openManagedIngress(options), /Active candidate pointer/);
  assert.equal((await readMigrationJournal(options.journalPath)).phase, "locally-healthy");
  assert.equal(steps.length, 0);
});

test("OPS-07: failed public probe reinstalls boot guard before closing ingress", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { options, steps } = await fixture(t);
  await assert.rejects(openManagedIngress({ ...options,
    assertPublicPaused: async () => { throw new Error("public probe failed"); },
    stopUnit: async unit => {
      assert.match(await readFile(options.marker, "utf8"), /migration-incomplete/);
      steps.push(`stop:${unit}`);
    } }), /public probe failed/);
  assert.equal((await readMigrationJournal(options.journalPath)).phase, "ingress-open");
  assert.equal((await inspectMigrationRecovery({ journalPath: options.journalPath, marker: options.marker })).state,
    "possibly-exposed");
  assert.match(await readFile(options.admissionFlag, "utf8"), /admission-paused/);
  assert.deepEqual(steps.filter(step => step.startsWith("stop:")), [
    "stop:dp-beget-oauth-proxy.socket", "stop:dp-beget-oauth-proxy.service", "stop:dp-beget-tunnel.service"]);
});

test("OPS-07: public paused proof precedes admission resume and completed journal", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { options, steps } = await fixture(t);
  const report = await openManagedIngress({ ...options, resume: async ({ flag, assertHealthy }) => {
    assert.equal(flag, options.admissionFlag);
    await assertHealthy();
    steps.push("resume");
    await rm(flag);
  } });
  assert.equal(report.phase, "completed");
  assert.equal((await readMigrationJournal(options.journalPath)).phase, "completed");
  assert.equal(steps.indexOf("public-paused") < steps.indexOf("resume"), true);
  await assert.rejects(stat(options.marker), /ENOENT/);
  await assert.rejects(stat(options.admissionFlag), /ENOENT/);
});

test("OPS-07: uncertain resume leaves exposed phase for explicit recovery", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { options, steps } = await fixture(t);
  await assert.rejects(openManagedIngress({ ...options, resume: async ({ flag }) => {
    await rm(flag);
    throw new Error("resume sync uncertain");
  } }), /resume sync uncertain/);
  assert.equal((await readMigrationJournal(options.journalPath)).phase, "ingress-open");
  assert.equal(steps.some(step => step.startsWith("stop:")), false);
  await assert.rejects(stat(options.marker), /ENOENT/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { INGRESS_UNITS, stageIngressBootGuard } from "../scripts/release/ingress-boot-guard.mjs";
import { installMigrationBootGuards } from "../scripts/release/install-migration-boot-guards.mjs";
import { readMigrationJournal, startMigrationJournal } from "../scripts/release/migration-journal.mjs";
import { MANAGED_APP_UNITS } from "../scripts/release/stage-managed-unit-overrides.mjs";
import { WRITER_GUARD_DROP_IN, stageWriterBootGuard } from "../scripts/release/writer-boot-guard.mjs";
import { legacyActivityFixture, unitBackupFixture } from "./fixtures/unit-backup.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-install-guards-"));
  const markerRoot = await mkdtemp("/var/lib/dp-install-guards-");
  const permitRoot = await mkdtemp("/run/dp-install-guards-");
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(markerRoot, { recursive: true, force: true }));
  t.after(() => rm(permitRoot, { recursive: true, force: true }));
  const marker = path.join(markerRoot, "migration-incomplete");
  const permit = path.join(permitRoot, "writer-start-allowed");
  const { backupDir } = await unitBackupFixture(t);
  const unitDirectory = path.join(root, "units");
  await mkdir(unitDirectory);
  const manifestPath = path.join(backupDir, "backup-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const entry of manifest.files) {
    await writeFile(path.join(unitDirectory, entry.path),
      await readFile(path.join(backupDir, "files", entry.path)));
    await chmod(path.join(unitDirectory, entry.path), entry.mode);
  }
  const oauth = "dp-beget-mcp-oauth-spike.service";
  const relative = `${oauth}.d/10-dp012-dcr.conf`;
  const content = Buffer.from("[Service]\nWorkingDirectory=/opt/dp-beget-bridge-dp012-dcr\n");
  await mkdir(path.join(backupDir, "files", `${oauth}.d`), { mode: 0o700 });
  await mkdir(path.join(unitDirectory, `${oauth}.d`));
  await writeFile(path.join(backupDir, "files", relative), content, { mode: 0o600 });
  await writeFile(path.join(unitDirectory, relative), content, { mode: 0o644 });
  manifest.files.push({ unit: oauth, path: relative, uid: 0, gid: 0, mode: 0o644,
    size: content.length, sha256: createHash("sha256").update(content).digest("hex") });
  await writeFile(manifestPath, JSON.stringify(manifest));
  const journalPath = path.join(root, "journal.json");
  await startMigrationJournal(journalPath, { oldCommit: "a".repeat(40), newCommit: "b".repeat(40),
    artifactSha256: "c".repeat(64), unitBackupDir: backupDir, inspectServices: legacyActivityFixture });
  const stagedIngress = path.join(root, "staged-ingress");
  const stagedWriters = path.join(root, "staged-writers");
  await stageIngressBootGuard({ outputDir: stagedIngress, marker });
  await stageWriterBootGuard({ outputDir: stagedWriters, marker, permit });
  return { journalPath, unitDirectory, stagedIngress, stagedWriters, marker, permit };
}

test("OPS-07: journal intent precedes installing and loading all seven guards", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  const steps = [];
  const report = await installMigrationBootGuards({ ...options,
    daemonReload: async () => {
      assert.equal((await readMigrationJournal(options.journalPath)).phase, "guarded");
      steps.push("reload");
    }, inspectIngress: async () => { steps.push("ingress-loaded"); },
    inspectWriters: async () => { steps.push("writers-loaded"); } });
  assert.deepEqual(steps, ["reload", "ingress-loaded", "writers-loaded"]);
  assert.equal(report.guardedUnits.length, 7);
  for (const unit of MANAGED_APP_UNITS) {
    assert.equal((await stat(path.join(options.unitDirectory, `${unit}.d`, WRITER_GUARD_DROP_IN))).mode & 0o777, 0o600);
  }
  for (const unit of INGRESS_UNITS) {
    assert.equal((await stat(path.join(options.unitDirectory, `${unit}.d`,
      "90-dp-r0004-migration-guard.conf"))).mode & 0o777, 0o600);
  }
  await assert.rejects(stat(options.marker), /ENOENT/);
});

test("OPS-07: changed original unit or staged guard blocks installation before intent", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await writeFile(path.join(options.unitDirectory, "dp-beget-agent.service"), "tampered");
  await assert.rejects(installMigrationBootGuards(options), /Legacy systemd file changed/);
  assert.equal((await readMigrationJournal(options.journalPath)).phase, "prepared");
});

test("OPS-07: changed staged writer guard blocks installation before intent", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await writeFile(path.join(options.stagedWriters, "dp-beget-agent.service.d", WRITER_GUARD_DROP_IN),
    "[Unit]\nConditionPathExists=/wrong\n");
  await assert.rejects(installMigrationBootGuards(options), /Untrusted staged boot guard/);
  assert.equal((await readMigrationJournal(options.journalPath)).phase, "prepared");
});

test("OPS-07: failed reload retains guarded intent without creating migration marker", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await assert.rejects(installMigrationBootGuards({ ...options,
    daemonReload: async () => { throw new Error("reload failed"); } }), /reload failed/);
  assert.equal((await readMigrationJournal(options.journalPath)).phase, "guarded");
  await assert.rejects(stat(options.marker), /ENOENT/);
});

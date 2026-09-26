import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restoreSystemdUnitBackup } from "../scripts/release/restore-systemd-unit-backup.mjs";
import { verifySystemdUnitBackup } from "../scripts/release/verify-systemd-unit-backup.mjs";
import { unitBackupFixture } from "./fixtures/unit-backup.js";

async function fixture(t) {
  const { backupDir } = await unitBackupFixture(t);
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-original-unit-view-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { backupDir, outputDir: path.join(root, "original-units"),
    expectedManifestSha256: (await verifySystemdUnitBackup({ backupDir })).manifestSha256 };
}

test("OPS-07: stages the journal-bound original seven unit files privately", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  const result = await restoreSystemdUnitBackup(options);
  assert.equal(result.files, 7);
  assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
  const file = path.join(result.directory, "dp-beget-session-host.service");
  assert.match(await readFile(file, "utf8"), /Description=dp-beget-session-host.service/);
  assert.equal((await stat(file)).mode & 0o777, 0o644);
});

test("OPS-07: wrong journal digest refuses original unit staging", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await assert.rejects(restoreSystemdUnitBackup({ ...options,
    expectedManifestSha256: "a".repeat(64) }), /no longer matches/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: changed unit bytes refuse original unit staging", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await writeFile(path.join(options.backupDir, "files", "dp-beget-agent.service"), "tampered\n");
  await assert.rejects(restoreSystemdUnitBackup(options), /digest mismatch|Untrusted unit backup file/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

test("OPS-07: a pre-existing output never gets overwritten", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await writeFile(options.outputDir, "keep\n");
  await assert.rejects(restoreSystemdUnitBackup(options), /EEXIST/);
  assert.equal(await readFile(options.outputDir, "utf8"), "keep\n");
});

test("OPS-07: invalid late unit metadata removes partial staged originals", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  const manifestPath = path.join(options.backupDir, "backup-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files.at(-1).mode = 0o1000;
  const bytes = JSON.stringify(manifest);
  await writeFile(manifestPath, bytes);
  options.expectedManifestSha256 = createHash("sha256").update(bytes).digest("hex");
  await assert.rejects(restoreSystemdUnitBackup(options), /Invalid original unit ownership/);
  await assert.rejects(stat(options.outputDir), /ENOENT/);
});

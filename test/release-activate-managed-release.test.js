import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { activateManagedRelease } from "../scripts/release/activate-managed-release.mjs";
import { advanceMigrationJournal, readMigrationJournal, startMigrationJournal } from "../scripts/release/migration-journal.mjs";
import { legacyActivityFixture, unitBackupFixture } from "./fixtures/unit-backup.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-activate-managed-"));
  const markerRoot = await mkdtemp("/var/lib/dp-activate-test-");
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(markerRoot, { recursive: true, force: true }));
  const { backupDir } = await unitBackupFixture(t);
  const marker = path.join(markerRoot, "migration-incomplete");
  await writeFile(marker, "dp-beget-bridge-migration-incomplete-v1\n", { mode: 0o600 });
  const releaseRoot = path.join(root, "managed");
  const versionDir = `1.0.0-${"b".repeat(40)}`;
  const destination = path.join(releaseRoot, "releases", versionDir);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "package.json"), JSON.stringify({ name: "dp-beget-bridge", version: "1.0.0" }));
  const journalPath = path.join(root, "journal.json");
  const artifactSha256 = "c".repeat(64);
  await startMigrationJournal(journalPath, { oldCommit: "a".repeat(40), newCommit: "b".repeat(40),
    artifactSha256, unitBackupDir: backupDir, inspectServices: legacyActivityFixture });
  for (const [before, after] of [["prepared", "guarded"], ["guarded", "ingress-closed"],
    ["ingress-closed", "quiesced"]]) await advanceMigrationJournal(journalPath, before, after);
  const snapshotPath = path.join(root, "snapshot");
  await mkdir(snapshotPath, { mode: 0o700 });
  const manifest = Buffer.from("fixture-manifest\n");
  await writeFile(path.join(snapshotPath, "bundle-manifest.json"), manifest, { mode: 0o600 });
  await advanceMigrationJournal(journalPath, "quiesced", "snapshotted", { snapshotPath,
    snapshotSha256: createHash("sha256").update(manifest).digest("hex") });
  await advanceMigrationJournal(journalPath, "snapshotted", "switched");
  return { root, marker, releaseRoot, versionDir, journalPath, artifactSha256 };
}

test("OPS-07: candidate services start in order under paused admission and closed ingress", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  const steps = [];
  const report = await activateManagedRelease({ ...options,
    inspectManaged: async () => { steps.push("units-loaded"); },
    assertWritersStopped: async () => { steps.push("writers-stopped"); },
    getState: async () => "inactive",
    pause: async () => { steps.push("paused"); },
    withPermit: async ({ action }) => { steps.push("permit-open");
      try { return await action(); } finally { steps.push("permit-closed"); } },
    startUnit: async unit => { steps.push(unit); },
    assertHealthy: async () => { steps.push("healthy"); } });
  assert.equal(steps.indexOf("paused") < steps.indexOf("dp-beget-session-host.service"), true);
  assert.deepEqual(steps.slice(-6), ["dp-beget-session-host.service", "dp-beget-agent.service",
    "dp-beget-mcp.service", "dp-beget-mcp-oauth-spike.service", "healthy", "permit-closed"]);
  assert.equal(report.admission, "paused");
  assert.equal((await readMigrationJournal(options.journalPath)).phase, "locally-healthy");
  assert.equal(await readlink(path.join(options.releaseRoot, "current")), `releases/${options.versionDir}`);
  assert.match(await readFile(options.marker, "utf8"), /migration-incomplete/);
});

test("OPS-07: health failure stops candidate, restores pointer and keeps ingress closed", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  const stopped = [];
  await assert.rejects(activateManagedRelease({ ...options,
    inspectManaged: async () => {}, assertWritersStopped: async () => {},
    withPermit: async ({ action }) => action(),
    getState: async () => "inactive", pause: async () => {}, startUnit: async () => {},
    stopUnit: async unit => { stopped.push(unit); },
    assertHealthy: async () => { throw new Error("candidate unhealthy"); } }), /candidate unhealthy/);
  assert.deepEqual(stopped, ["dp-beget-mcp-oauth-spike.service", "dp-beget-mcp.service",
    "dp-beget-agent.service", "dp-beget-session-host.service"]);
  await assert.rejects(stat(path.join(options.releaseRoot, "current")), /ENOENT/);
  assert.equal((await readMigrationJournal(options.journalPath)).phase, "switched");
  assert.match(await readFile(options.marker, "utf8"), /migration-incomplete/);
});

test("OPS-07: a failed systemd start also stops the possibly live failed unit", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  const stopped = [];
  await assert.rejects(activateManagedRelease({ ...options,
    inspectManaged: async () => {}, assertWritersStopped: async () => {},
    withPermit: async ({ action }) => action(),
    getState: async () => "inactive", pause: async () => {},
    startUnit: async unit => { if (unit === "dp-beget-agent.service") throw new Error("start failed"); },
    stopUnit: async unit => { stopped.push(unit); }, assertHealthy: async () => {} }), /start failed/);
  assert.deepEqual(stopped, ["dp-beget-agent.service", "dp-beget-session-host.service"]);
  await assert.rejects(stat(path.join(options.releaseRoot, "current")), /ENOENT/);
});

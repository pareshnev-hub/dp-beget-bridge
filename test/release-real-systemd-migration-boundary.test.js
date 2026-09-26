import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { backupSystemdUnits } from "../scripts/release/backup-systemd-units.mjs";
import { closeLegacyIngress } from "../scripts/release/close-legacy-ingress.mjs";
import { stageIngressBootGuard } from "../scripts/release/ingress-boot-guard.mjs";
import { inspectLegacyServiceActivity } from "../scripts/release/legacy-service-activity.mjs";
import { installMigrationBootGuards } from "../scripts/release/install-migration-boot-guards.mjs";
import { readMigrationJournal, startMigrationJournal } from "../scripts/release/migration-journal.mjs";
import { quiesceLegacyWriters } from "../scripts/release/quiesce-legacy-writers.mjs";
import { stageWriterBootGuard } from "../scripts/release/writer-boot-guard.mjs";
import { assertWriterPermitAbsent, withWriterStartPermit } from "../scripts/release/writer-start-permit.mjs";

const exec = promisify(execFile);
const writers = ["dp-beget-session-host.service", "dp-beget-agent.service",
  "dp-beget-mcp.service", "dp-beget-mcp-oauth-spike.service"];
const ingress = ["dp-beget-oauth-proxy.socket", "dp-beget-oauth-proxy.service",
  "dp-beget-tunnel.service"];
const units = [...writers, ...ingress];
const unitDirectory = "/etc/systemd/system";
async function systemctl(...args) {
  return exec("systemctl", args, { timeout: 20000, maxBuffer: 4096 });
}
async function active(unit) {
  const { stdout } = await systemctl("show", unit, "--property=ActiveState", "--no-pager");
  return stdout.trim().slice("ActiveState=".length);
}

// This test uses the seven exact migration unit names on an isolated CI runner.
// It refuses to overwrite any pre-existing unit or work directory and cleans
// only paths that it exclusively created. It never targets the Beget VPS.
test("OPS-07: seven real systemd units close ingress and quiesce writers under loaded guards", async t => {
  if (process.env.DP_TEST_REAL_SYSTEMD !== "1" || process.getuid?.() !== 0) {
    t.skip("requires a disposable root systemd CI runner");
    return;
  }
  for (const unit of units) {
    const { stdout } = await systemctl("show", unit, "--property=LoadState", "--no-pager");
    assert.equal(stdout.trim(), "LoadState=not-found", `Refusing an existing ${unit}`);
    await assert.rejects(stat(path.join(unitDirectory, `${unit}.d`)), { code: "ENOENT" });
  }
  const workdirs = ["/opt/dp-beget-bridge", "/opt/dp-beget-bridge-dp012-dcr",
    "/var/lib/dp-beget-tunnel"];
  for (const directory of workdirs) {
    await assert.rejects(stat(directory), { code: "ENOENT" });
  }
  const root = await mkdtemp("/var/lib/dp-r0004-systemd-rehearsal-");
  const runtime = await mkdtemp("/run/dp-r0004-systemd-rehearsal-");
  const created = [];
  t.after(async () => {
    for (const unit of units) await systemctl("stop", unit).catch(() => {});
    for (const filename of created.reverse()) await rm(filename, { recursive: true, force: true });
    await systemctl("daemon-reload");
    for (const unit of units) await systemctl("reset-failed", unit).catch(() => {});
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  });
  for (const directory of workdirs) {
    await mkdir(directory, { mode: 0o755 });
    created.push(directory);
  }
  for (const unit of writers) {
    const killMode = unit === "dp-beget-session-host.service" ? "KillMode=process\n" : "";
    const filename = path.join(unitDirectory, unit);
    await writeFile(filename, `[Unit]\nDescription=Disposable R0004 ${unit}\n` +
      `[Service]\nType=oneshot\nRemainAfterExit=yes\nUser=nobody\n` +
      `WorkingDirectory=/opt/dp-beget-bridge\n${killMode}ExecStart=/usr/bin/true\n`,
    { flag: "wx", mode: 0o644 });
    created.push(filename);
  }
  const oauthDropins = path.join(unitDirectory, "dp-beget-mcp-oauth-spike.service.d");
  await mkdir(oauthDropins, { mode: 0o755 });
  created.push(oauthDropins);
  await writeFile(path.join(oauthDropins, "10-dp012-dcr.conf"),
    "[Service]\nWorkingDirectory=/opt/dp-beget-bridge-dp012-dcr\n",
  { flag: "wx", mode: 0o644 });
  for (const unit of units.filter(item => item !== "dp-beget-mcp-oauth-spike.service")) {
    created.push(path.join(unitDirectory, `${unit}.d`));
  }
  await writeFile(path.join(unitDirectory, ingress[0]),
    `[Unit]\nDescription=Disposable OAuth socket\n[Socket]\nListenStream=${runtime}/proxy.sock\nSocketMode=0600\n`,
  { flag: "wx", mode: 0o644 });
  created.push(path.join(unitDirectory, ingress[0]));
  for (const unit of ingress.slice(1)) {
    const workdir = unit === ingress[2] ? "WorkingDirectory=/var/lib/dp-beget-tunnel\n" : "";
    const filename = path.join(unitDirectory, unit);
    await writeFile(filename, `[Unit]\nDescription=Disposable R0004 ${unit}\n` +
      `[Service]\nType=oneshot\nRemainAfterExit=yes\nDynamicUser=yes\nUser=${unit === ingress[2] ? "dp-tunnel" : "dp-beget-oauth-proxy"}\n` +
      `${workdir}ExecStart=/usr/bin/true\n`, { flag: "wx", mode: 0o644 });
    created.push(filename);
  }
  await systemctl("daemon-reload");
  for (const unit of [...writers, ingress[0], ingress[2]]) await systemctl("start", unit);
  assert.equal((await inspectLegacyServiceActivity())[ingress[1]], "inactive");
  const backupDir = path.join(root, "unit-backup");
  const manifest = await backupSystemdUnits({ outputDir: backupDir, unitDirectory });
  assert.equal(manifest.files.length, 8);
  const journalPath = path.join(root, "migration-journal.json");
  const marker = path.join(root, "migration-incomplete");
  const permit = path.join(runtime, "writer-start-allowed");
  await startMigrationJournal(journalPath, { oldCommit: "a".repeat(40), newCommit: "b".repeat(40),
    artifactSha256: "c".repeat(64), unitBackupDir: backupDir });
  const stagedIngress = path.join(root, "staged-ingress");
  const stagedWriters = path.join(root, "staged-writers");
  await stageIngressBootGuard({ outputDir: stagedIngress, marker });
  await stageWriterBootGuard({ outputDir: stagedWriters, marker, permit });
  await installMigrationBootGuards({ journalPath, unitDirectory, stagedIngress, stagedWriters,
    marker, permit });
  for (const unit of [...writers, ingress[0], ingress[2]]) assert.equal(await active(unit), "active");
  // The disposable runner has no public OAuth route. This injected proof
  // stands only for its isolated fixture, never for a Beget migration.
  await closeLegacyIngress({ journalPath, unitDirectory, marker, permit,
    assertRouteExclusive: async () => true });
  for (const unit of ingress) assert.equal(await active(unit), "inactive");
  // Real systemd refuses an ingress restart while the durable marker exists.
  await systemctl("start", ingress[0]).catch(() => {});
  assert.equal(await active(ingress[0]), "inactive");
  const stateDatabase = path.join(root, "dummy-ledger.sqlite");
  await quiesceLegacyWriters({ journalPath, marker, permit, stateDatabase, unitDirectory,
    assertNoInFlight: async () => {}, assertLedgerSafe: async () => {} });
  for (const unit of writers) assert.equal(await active(unit), "inactive");
  await systemctl("start", writers[0]).catch(() => {});
  assert.equal(await active(writers[0]), "inactive");
  assert.equal((await readMigrationJournal(journalPath)).phase, "quiesced");
  assert.ok((await stat(marker)).isFile());

  // Rehearse the old-writer restart boundary under the same seven loaded
  // guards. In this fixture the units do no work and no state is restored.
  await withWriterStartPermit({ marker, permit, action: async () => {
    for (const unit of writers) {
      await systemctl("start", unit);
      assert.equal(await active(unit), "active");
    }
    for (const unit of ingress) assert.equal(await active(unit), "inactive");
    await systemctl("start", ingress[0]).catch(() => {});
    assert.equal(await active(ingress[0]), "inactive");
  } });
  await assertWriterPermitAbsent(permit);
  assert.ok((await stat(marker)).isFile());
  for (const unit of writers) await systemctl("stop", unit);
  await systemctl("start", writers[0]).catch(() => {});
  for (const unit of writers) assert.equal(await active(unit), "inactive");
  for (const unit of ingress) assert.equal(await active(unit), "inactive");
  assert.equal((await readMigrationJournal(journalPath)).phase, "quiesced");
});

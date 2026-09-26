import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmod, mkdtemp, mkdir, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { backupSystemdUnits } from "../scripts/release/backup-systemd-units.mjs";
import { activateManagedRelease } from "../scripts/release/activate-managed-release.mjs";
import { pauseAdmission } from "../scripts/release/admission-pause.mjs";
import { buildArtifact } from "../scripts/release/build-artifact.mjs";
import { closeLegacyIngress } from "../scripts/release/close-legacy-ingress.mjs";
import { stageIngressBootGuard } from "../scripts/release/ingress-boot-guard.mjs";
import { inspectLegacyServiceActivity } from "../scripts/release/legacy-service-activity.mjs";
import { installMigrationBootGuards } from "../scripts/release/install-migration-boot-guards.mjs";
import { installManagedOverrides } from "../scripts/release/install-managed-overrides.mjs";
import { inspectInstalledManagedUnits } from "../scripts/release/installed-managed-unit-preflight.mjs";
import { readMigrationJournal, startMigrationJournal } from "../scripts/release/migration-journal.mjs";
import { quiesceLegacyWriters } from "../scripts/release/quiesce-legacy-writers.mjs";
import { openManagedIngress } from "../scripts/release/open-managed-ingress.mjs";
import { pinReleaseKey } from "../scripts/release/pin-release-key.mjs";
import { prepareRelease } from "../scripts/release/prepare-release.mjs";
import { promotePreparedRelease } from "../scripts/release/promote-prepared-release.mjs";
import { recoverFirstMigration } from "../scripts/release/recover-first-migration.mjs";
import { reopenLegacyIngress } from "../scripts/release/reopen-legacy-ingress.mjs";
import { restartLegacyAfterRollback } from "../scripts/release/restart-legacy-after-rollback.mjs";
import { snapshotLegacyState } from "../scripts/release/snapshot-legacy-state.mjs";
import { signManifest } from "../scripts/release/sign-manifest.mjs";
import { stageManagedUnitOverrides } from "../scripts/release/stage-managed-unit-overrides.mjs";
import { stopCandidateForRollback } from "../scripts/release/stop-candidate-for-rollback.mjs";
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
    "/var/lib/dp-beget-tunnel", "/var/lib/dp-beget-bridge"];
  for (const directory of workdirs) {
    await assert.rejects(stat(directory), { code: "ENOENT" });
  }
  const root = await mkdtemp("/var/lib/dp-r0004-systemd-rehearsal-");
  await chmod(root, 0o755); // inert service users must traverse the version pointer
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
  // The fixture uses a temporary signing key and a pinned public key in a
  // private root directory. This exercises the actual artifact-to-pointer
  // path; production key custody and real service handlers are separate gates.
  const commit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  const built = await buildArtifact({ commit, outputDir: path.join(root, "signed-candidate") });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const releasePrivate = path.join(root, "release-private");
  await mkdir(releasePrivate, { mode: 0o700 });
  const privateFile = path.join(releasePrivate, "private.pem");
  const publicFile = path.join(releasePrivate, "public.pem");
  const publicBytes = publicKey.export({ type: "spki", format: "pem" });
  await writeFile(privateFile, privateKey.export({ type: "pkcs8", format: "pem" }), { flag: "wx", mode: 0o600 });
  await writeFile(publicFile, publicBytes, { flag: "wx", mode: 0o600 });
  const signature = path.join(root, "signed-candidate", "manifest.sig");
  await signManifest({ ...built, privateKey: privateFile, signature });
  const trustDir = path.join(releasePrivate, "trust");
  await pinReleaseKey({ source: publicFile,
    expectedSha256: createHash("sha256").update(publicBytes).digest("hex"), trustDir });
  const artifactSha256 = JSON.parse(await readFile(built.manifest, "utf8")).artifact.sha256;
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
  await startMigrationJournal(journalPath, { oldCommit: "a".repeat(40), newCommit: commit,
    artifactSha256, unitBackupDir: backupDir });
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
    assertRouteExclusive: async () => true, assertPublicLegacy: async () => true,
    assertPublicClosed: async () => true });
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
  await assert.rejects(withWriterStartPermit({ marker, permit, action: async () => {
    await systemctl("start", writers[0]);
    assert.equal(await active(writers[0]), "active");
    throw new Error("injected old writer start interruption");
  } }), /injected old writer start interruption/);
  await assertWriterPermitAbsent(permit);
  assert.equal(await active(writers[0]), "active");
  for (const unit of writers.slice(1)) assert.equal(await active(unit), "inactive");
  await systemctl("start", writers[1]).catch(() => {});
  assert.equal(await active(writers[1]), "inactive");
  for (const unit of ingress) assert.equal(await active(unit), "inactive");

  // Only the already-active prefix survives the interruption. A new permit
  // restarts the remaining writers without opening dedicated public ingress.
  await withWriterStartPermit({ marker, permit, action: async () => {
    for (const unit of writers.slice(1)) {
      await systemctl("start", unit);
      assert.equal(await active(unit), "active");
    }
    assert.equal(await active(writers[0]), "active");
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

  // Advance through a real grouped snapshot and loaded managed drop-ins.
  // The inert candidate is never started, so this is still a closed-ingress
  // boundary rehearsal, not a full activation or rollback test.
  const configRoot = path.join(root, "config");
  await mkdir(configRoot, { mode: 0o700 });
  await writeFile(path.join(configRoot, "settings.json"), "{}\n", { mode: 0o600 });
  const databases = [];
  for (const name of ["session-host", "agent", "oauth"]) {
    const source = name === "session-host" ? "/var/lib/dp-beget-bridge/state.sqlite"
      : path.join(root, `${name}.sqlite`);
    const db = new DatabaseSync(source);
    try {
      db.exec("CREATE TABLE rehearsal (id INTEGER PRIMARY KEY)");
      if (name === "session-host") db.exec("PRAGMA user_version=1; CREATE TABLE operations (status TEXT NOT NULL)");
    }
    finally { db.close(); }
    databases.push({ name, source });
  }
  const outputDir = path.join(root, "state-snapshot");
  await snapshotLegacyState({ journalPath, marker, permit, unitDirectory,
    configRoot, databases, outputDir });
  assert.equal((await readMigrationJournal(journalPath)).phase, "snapshotted");
  const releaseRoot = path.join(root, "candidate");
  await mkdir(releaseRoot, { mode: 0o755 });
  const stagedDirectory = path.join(root, "staged-managed");
  await stageManagedUnitOverrides({ outputDir: stagedDirectory, releaseRoot });
  await installManagedOverrides({ journalPath, marker, permit, unitDirectory,
    stagedDirectory, releaseRoot });
  await inspectInstalledManagedUnits({ unitDirectory, releaseRoot, marker, permit });
  assert.equal((await readMigrationJournal(journalPath)).phase, "switched");
  await systemctl("start", writers[0]).catch(() => {});
  for (const unit of writers) assert.equal(await active(unit), "inactive");
  for (const unit of ingress) assert.equal(await active(unit), "inactive");
  assert.ok((await stat(marker)).isFile());

  // Prepare and promote the exact signed commit bound to the journal. The
  // separate CI dependency test covers npm ci; this fixture keeps its
  // systemd services inert and never starts application HTTP handlers.
  await mkdir(path.join(releaseRoot, "releases"));
  const workspace = path.join(releasePrivate, "prepared");
  const prepared = await prepareRelease({ ...built, signature, trustDir, workspace,
    installDependencies: async ({ directory }) => {
      await mkdir(path.join(directory, "node_modules"));
    } });
  const promoted = await promotePreparedRelease({ workspace, releaseRoot, trustDir });
  const versionDir = promoted.versionDir;
  assert.equal(prepared.commit, commit);
  assert.equal(promoted.sha256, artifactSha256);
  assert.equal(versionDir, `${prepared.version}-${commit}`);
  const admissionFlag = path.join(root, "admission", "paused");
  await activateManagedRelease({ journalPath, marker, permit, unitDirectory,
    releaseRoot, versionDir, artifactSha256,
    pause: () => pauseAdmission({ flag: admissionFlag }),
    assertHealthy: async () => {
      for (const unit of writers) assert.equal(await active(unit), "active");
      for (const unit of ingress) assert.equal(await active(unit), "inactive");
    } });
  assert.equal((await readMigrationJournal(journalPath)).phase, "locally-healthy");
  assert.equal(await readlink(path.join(releaseRoot, "current")), `releases/${versionDir}`);
  await assertWriterPermitAbsent(permit);

  // Public admission fails before exposure; the candidate has changed one
  // disposable database, which the rollback must restore from the snapshot.
  const agentSource = databases.find(item => item.name === "agent").source;
  const changed = new DatabaseSync(agentSource);
  try { changed.exec("INSERT INTO rehearsal (id) VALUES (1)"); }
  finally { changed.close(); }
  await assert.rejects(openManagedIngress({ journalPath, marker, permit, unitDirectory,
    releaseRoot, versionDir, artifactSha256, admissionFlag,
    assertLocalPaused: async () => {}, assertRouteExclusive: async () => false }),
  /Exclusive public OAuth route not proven/);
  assert.equal((await readMigrationJournal(journalPath)).phase, "locally-healthy");
  assert.ok((await stat(marker)).isFile());

  const legacyHealthy = async () => ({ services: 4, products: ["DP Beget Bridge",
    "DP Beget Bridge", "DP Beget Bridge", "DP Beget Bridge Session Host"] });
  const record = name => path.join(root, name);
  const recovered = await recoverFirstMigration({ journalPath, marker, permit,
    unitDirectory, releaseRoot, versionDir, admissionFlag,
    recoveryRoot: record("staged-recovery"), planPath: record("rollback-intent.json"),
    stopRecordPath: record("candidate-stop.json"), unitRecordPath: record("units-restored.json"),
    copyRecordPath: record("state-copies.json"), ledgerPath: record("replacement-ledger.json"),
    pointerRecordPath: record("pointer-removed.json"),
    restartRecordPath: record("legacy-started.json"), ingressRecordPath: record("legacy-exposed.json"),
    assertRouteExclusive: async () => true,
    stopCandidate: options => stopCandidateForRollback({ ...options,
      assertPaused: async () => {} }),
    restartLegacy: options => restartLegacyAfterRollback({ ...options,
      assertLegacyHealthy: legacyHealthy }),
    reopenIngress: options => reopenLegacyIngress({ ...options,
      assertLegacyHealthy: legacyHealthy, assertPublicLegacy: async () => true }) });
  assert.equal(recovered.phase, "ingress-open");
  assert.equal((await readMigrationJournal(journalPath)).phase, "ingress-open");
  for (const unit of writers) assert.equal(await active(unit), "active");
  for (const unit of [ingress[0], ingress[2]]) assert.equal(await active(unit), "active");
  await assert.rejects(stat(marker), { code: "ENOENT" });
  await assert.rejects(readlink(path.join(releaseRoot, "current")), { code: "ENOENT" });
  const restored = new DatabaseSync(agentSource, { readOnly: true });
  try { assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM rehearsal").get().n, 0); }
  finally { restored.close(); }
});

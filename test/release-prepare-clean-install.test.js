import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildArtifact } from "../scripts/release/build-artifact.mjs";
import { verifyCleanInstallManifest } from "../scripts/release/clean-install-manifest.mjs";
import { advanceCleanInstallJournal, readCleanInstallJournal,
  startCleanInstallJournal } from "../scripts/release/clean-install-journal.mjs";
import { installCleanIdentities } from "../scripts/release/install-clean-identities.mjs";
import { installCleanConfig } from "../scripts/release/install-clean-config.mjs";
import { installCleanUnits } from "../scripts/release/install-clean-units.mjs";
import { installCleanData } from "../scripts/release/install-clean-data.mjs";
import { inspectInstalledCleanConfig } from "../scripts/release/inspect-installed-clean-config.mjs";
import { inspectInstalledCleanUnits } from "../scripts/release/inspect-installed-clean-units.mjs";
import { inspectInstalledCleanData } from "../scripts/release/clean-install-data-directories.mjs";
import { installCleanReleaseRoot, inspectCreatedCleanReleaseRoot } from "../scripts/release/clean-install-release-root.mjs";
import { promoteCleanInstall } from "../scripts/release/promote-clean-install.mjs";
import { inspectPromotedCleanRelease } from "../scripts/release/inspect-promoted-clean-release.mjs";
import { recoverCompletedCleanPromotion } from "../scripts/release/recover-completed-clean-promotion.mjs";
import { installCleanPointer } from "../scripts/release/install-clean-pointer.mjs";
import { recoverCompletedCleanPointer } from "../scripts/release/recover-completed-clean-pointer.mjs";
import { inspectCleanSystemdBoundary, inspectCleanSystemdInactivity } from
  "../scripts/release/inspect-clean-systemd-boundary.mjs";
import { loadCleanSystemdUnits } from "../scripts/release/load-clean-systemd-units.mjs";
import { recoverCompletedCleanSystemd } from "../scripts/release/recover-completed-clean-systemd.mjs";
import { installCleanAdmissionPause } from "../scripts/release/install-clean-admission-pause.mjs";
import { recoverCompletedCleanAdmission } from "../scripts/release/recover-completed-clean-admission.mjs";
import { startCleanLocalServices } from "../scripts/release/start-clean-local-services.mjs";
import { recoverCleanLocalStartup } from "../scripts/release/recover-clean-local-startup.mjs";
import { pauseAdmission, verifyAdmissionPause } from "../scripts/release/admission-pause.mjs";
import { DEFAULT_ADMISSION_PAUSE_PATH, isAdmissionPaused } from
  "../packages/core/src/admission-gate.js";
import { CLEAN_INSTALL_UNIT_NAMES } from "../scripts/release/preflight-clean-install.mjs";
import { recoverCompletedCleanReleaseRoot } from "../scripts/release/recover-completed-clean-release-root.mjs";
import { recoverCompletedCleanIdentities } from "../scripts/release/recover-completed-clean-identities.mjs";
import { recoverCompletedCleanConfig } from "../scripts/release/recover-completed-clean-config.mjs";
import { recoverCompletedCleanUnits } from "../scripts/release/recover-completed-clean-units.mjs";
import { recoverCompletedCleanData } from "../scripts/release/recover-completed-clean-data.mjs";
import { pinReleaseKey } from "../scripts/release/pin-release-key.mjs";
import { prepareCleanInstall } from "../scripts/release/prepare-clean-install.mjs";
import { prepareRelease } from "../scripts/release/prepare-release.mjs";
import { signManifest } from "../scripts/release/sign-manifest.mjs";

const exec = promisify(execFile);

test("OPS-01/05: signed clean-install candidate stages config and units without a live install", {
  skip: process.getuid?.() !== 0
}, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "dp-clean-preparation-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const commit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  const built = await buildArtifact({ commit, outputDir: path.join(base, "candidate") });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicBytes = publicKey.export({ format: "pem", type: "spki" });
  const publicFile = path.join(base, "public.pem");
  const privateFile = path.join(base, "private.pem");
  await writeFile(publicFile, publicBytes);
  await writeFile(privateFile, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const signature = path.join(base, "candidate", "manifest.sig");
  await signManifest({ ...built, privateKey: privateFile, signature });
  const workspaceParent = path.join(base, "private");
  await mkdir(workspaceParent, { mode: 0o700 });
  const trustDir = path.join(workspaceParent, "trust");
  await pinReleaseKey({ source: publicFile,
    expectedSha256: createHash("sha256").update(publicBytes).digest("hex"), trustDir });
  const sha256 = JSON.parse(await readFile(built.manifest, "utf8")).artifact.sha256;
  let preflights = 0;
  const args = { ...built, signature, trustDir, workspaceParent,
    workspace: path.join(workspaceParent, "new-candidate"), releaseRoot: path.join(base, "version-root"),
    domain: "bridge.example.com", expectedIp: "1.1.1.1", allowedRoot: "/srv/operator",
    workUser: "operator", workGroup: "operator", agentUser: "dp-agent",
    mcpUser: "dp-mcp", ipcGroup: "dp-ipc",
    inspect: async () => { preflights++; return { candidate: { sha256 } }; },
    prepare: options => prepareRelease({ ...options, installDependencies: async ({ directory }) => {
      await mkdir(path.join(directory, "node_modules"));
    } }) };
  const result = await prepareCleanInstall(args);
  assert.equal(preflights, 1);
  assert.equal(result.sha256, sha256);
  assert.equal(result.units, 3);
  assert.equal(result.configFiles, 3);
  assert.match(result.manifestSha256, /^[0-9a-f]{64}$/);
  assert.equal((await verifyCleanInstallManifest({ workspace: args.workspace,
    trustDir, manifestSha256: result.manifestSha256 })).files, 6);
  assert.doesNotMatch(JSON.stringify(result), /DP_AGENT_TOKEN|DP_MCP_ACCESS_TOKEN/);
  const unit = path.join(args.workspace, "clean-install", "units", "dp-beget-agent.service");
  assert.ok((await readFile(unit, "utf8")).includes(`WorkingDirectory=${args.releaseRoot}/current\n`));
  assert.equal((await stat(unit)).mode & 0o777, 0o600);
  const journalPath = path.join(workspaceParent, "clean-install-journal.json");
  const journal = await startCleanInstallJournal({ journalPath, workspace: args.workspace,
    manifestSha256: result.manifestSha256, releaseRoot: args.releaseRoot, trustDir });
  assert.equal(journal.phase, "prepared");
  assert.deepEqual(journal.identityPlan, {
    workUser: "operator", workGroup: "operator", ipcGroup: "dp-ipc",
    agentUser: "dp-agent", mcpUser: "dp-mcp", allowedRoot: "/srv/operator",
    releaseRoot: args.releaseRoot, domain: "bridge.example.com"
  });
  assert.doesNotMatch(JSON.stringify(journal), /DP_AGENT_TOKEN|DP_MCP_ACCESS_TOKEN/);
  assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
  await assert.rejects(startCleanInstallJournal({ journalPath, workspace: args.workspace,
    manifestSha256: result.manifestSha256, releaseRoot: args.releaseRoot, trustDir }), /EEXIST/);
  await assert.rejects(advanceCleanInstallJournal({ journalPath,
    transactionId: journal.transactionId, expectedPhase: "prepared", nextPhase: "files-intent", trustDir }),
  /transition rejected/);
  assert.equal((await readCleanInstallJournal(journalPath)).phase, "prepared");
  assert.equal((await advanceCleanInstallJournal({ journalPath, transactionId: journal.transactionId,
    expectedPhase: "prepared", nextPhase: "identities-intent", trustDir })).phase, "identities-intent");
  const calls = [];
  const installed = await installCleanIdentities({ journalPath, trustDir,
    inspectAvailable: async () => {},
    addGroup: async name => { calls.push(`group:${name}`); },
    addUser: async (name, _, home) => { calls.push(`user:${name}:${home}`); },
    advance: options => advanceCleanInstallJournal({ ...options,
      inspectCreated: async () => ({ identities: "journal-bound" }) }) });
  assert.equal(installed.phase, "identities-ready");
  assert.deepEqual(calls, ["group:dp-ipc", "group:dp-agent", "group:dp-mcp",
    "user:dp-agent:/var/lib/dp-beget-bridge-agent",
    "user:dp-mcp:/var/lib/dp-beget-bridge-mcp"]);
  await assert.rejects(stat(`${journalPath}.identity-install.lock`), /ENOENT/);
  const identityEvidence = { identities: "journal-bound", ipcGid: 1,
    agentUid: 5, agentGid: 2, mcpUid: 6, mcpGid: 3 };
  const configDir = path.join(workspaceParent, "installed-config");
  if (process.env.DP_TEST_REAL_CHOWN === "1") {
    assert.equal((await advanceCleanInstallJournal({ journalPath,
      transactionId: journal.transactionId, expectedPhase: "identities-ready",
      nextPhase: "config-intent", trustDir,
      inspectCreated: async () => identityEvidence })).phase, "config-intent");
    assert.equal((await installCleanConfig({ journalPath, trustDir, configDir,
      inspectCreated: async () => identityEvidence,
      advance: options => advanceCleanInstallJournal({ ...options,
        inspectCreated: async () => identityEvidence }) })).phase, "config-ready");
    assert.equal((await stat(configDir)).mode & 0o777, 0o711);
    assert.equal((await stat(path.join(configDir, "agent.env"))).gid, identityEvidence.agentGid);
    assert.equal((await stat(path.join(configDir, "agent.env"))).mode & 0o777, 0o640);
    assert.equal((await inspectInstalledCleanConfig({ configDir, workspace: args.workspace,
      manifestSha256: result.manifestSha256, trustDir,
      identityPlan: journal.identityPlan, identities: identityEvidence })).config, "bound-private");
    await assert.rejects(stat(`${journalPath}.config-install.lock`), /ENOENT/);
    await assert.rejects(installCleanConfig({ journalPath, trustDir, configDir }), /journaled intent/);
    const configLock = `${journalPath}.config-install.lock`;
    const installedAgent = path.join(configDir, "agent.env");
    const originalAgent = await readFile(installedAgent);
    await writeFile(configLock, `${journal.transactionId}\n`, { mode: 0o600 });
    await writeFile(installedAgent, Buffer.concat([originalAgent, Buffer.from("DP_LOG_LEVEL=debug\n")]));
    await assert.rejects(recoverCompletedCleanConfig({ journalPath, trustDir, configDir,
      inspectCreated: async () => identityEvidence }), /differs/);
    assert.ok((await stat(configLock)).isFile());
    await writeFile(installedAgent, originalAgent);
    assert.equal((await recoverCompletedCleanConfig({ journalPath, trustDir, configDir,
      inspectCreated: async () => identityEvidence })).phase, "config-ready");
    await assert.rejects(stat(configLock), /ENOENT/);

    const interruptedPath = path.join(workspaceParent, "interrupted-config-journal.json");
    const interrupted = await startCleanInstallJournal({ journalPath: interruptedPath,
      workspace: args.workspace, manifestSha256: result.manifestSha256,
      releaseRoot: args.releaseRoot, trustDir });
    await advanceCleanInstallJournal({ journalPath: interruptedPath,
      transactionId: interrupted.transactionId, expectedPhase: "prepared",
      nextPhase: "identities-intent", trustDir });
    await installCleanIdentities({ journalPath: interruptedPath, trustDir,
      inspectAvailable: async () => {}, addGroup: async () => {}, addUser: async () => {},
      advance: options => advanceCleanInstallJournal({ ...options,
        inspectCreated: async () => identityEvidence }) });
    await advanceCleanInstallJournal({ journalPath: interruptedPath,
      transactionId: interrupted.transactionId, expectedPhase: "identities-ready",
      nextPhase: "config-intent", trustDir,
      inspectCreated: async () => identityEvidence });
    const interruptedDir = path.join(workspaceParent, "interrupted-config");
    await assert.rejects(installCleanConfig({ journalPath: interruptedPath, trustDir,
      configDir: interruptedDir, inspectCreated: async () => identityEvidence,
      advance: async () => { throw new Error("interrupted before config journal write"); } }),
    /interrupted before config journal write/);
    assert.equal((await readCleanInstallJournal(interruptedPath)).phase, "config-intent");
    assert.ok((await stat(`${interruptedPath}.config-install.lock`)).isFile());
    assert.equal((await recoverCompletedCleanConfig({ journalPath: interruptedPath,
      trustDir, configDir: interruptedDir,
      inspectCreated: async () => identityEvidence,
      advance: options => advanceCleanInstallJournal({ ...options,
        inspectCreated: async () => identityEvidence }) })).phase, "config-ready");
    await assert.rejects(stat(`${interruptedPath}.config-install.lock`), /ENOENT/);

    const unitDirectory = path.join(workspaceParent, "installed-units");
    await mkdir(unitDirectory, { mode: 0o755 });
    assert.equal((await advanceCleanInstallJournal({ journalPath,
      transactionId: journal.transactionId, expectedPhase: "config-ready",
      nextPhase: "units-intent", trustDir, configDir, unitDirectory,
      inspectCreated: async () => identityEvidence })).phase, "units-intent");
    assert.equal((await installCleanUnits({ journalPath, trustDir, configDir, unitDirectory,
      inspectCreated: async () => identityEvidence,
      advance: options => advanceCleanInstallJournal({ ...options,
        inspectCreated: async () => identityEvidence }) })).phase, "units-ready");
    assert.equal((await stat(path.join(unitDirectory, "dp-beget-agent.service"))).mode & 0o777,
      0o644);
    assert.equal((await inspectInstalledCleanUnits({ unitDirectory,
      workspace: args.workspace, manifestSha256: result.manifestSha256,
      trustDir })).units, "bound-files");
    await assert.rejects(stat(`${journalPath}.unit-install.lock`), /ENOENT/);
    await assert.rejects(installCleanUnits({ journalPath, trustDir, configDir,
      unitDirectory }), /journaled intent/);
    await writeFile(path.join(unitDirectory, "dp-beget-tunnel.service"), "unexpected\n");
    await assert.rejects(inspectInstalledCleanUnits({ unitDirectory,
      workspace: args.workspace, manifestSha256: result.manifestSha256,
      trustDir }), /Unexpected existing/);
    await rm(path.join(unitDirectory, "dp-beget-tunnel.service"));
    const unitLock = `${journalPath}.unit-install.lock`;
    const installedUnit = path.join(unitDirectory, "dp-beget-agent.service");
    const originalUnit = await readFile(installedUnit);
    await writeFile(unitLock, `${journal.transactionId}\n`, { mode: 0o600 });
    await writeFile(installedUnit, Buffer.concat([originalUnit, Buffer.from("# altered\n")]));
    await assert.rejects(recoverCompletedCleanUnits({ journalPath, trustDir,
      configDir, unitDirectory, inspectCreated: async () => identityEvidence }), /differs/);
    assert.ok((await stat(unitLock)).isFile());
    await writeFile(installedUnit, originalUnit);
    assert.equal((await recoverCompletedCleanUnits({ journalPath, trustDir,
      configDir, unitDirectory, inspectCreated: async () => identityEvidence })).phase,
    "units-ready");
    await assert.rejects(stat(unitLock), /ENOENT/);

    const interruptedUnitDir = path.join(workspaceParent, "interrupted-units");
    await mkdir(interruptedUnitDir, { mode: 0o755 });
    await advanceCleanInstallJournal({ journalPath: interruptedPath,
      transactionId: interrupted.transactionId, expectedPhase: "config-ready",
      nextPhase: "units-intent", trustDir, configDir: interruptedDir,
      unitDirectory: interruptedUnitDir, inspectCreated: async () => identityEvidence });
    await assert.rejects(installCleanUnits({ journalPath: interruptedPath,
      trustDir, configDir: interruptedDir, unitDirectory: interruptedUnitDir,
      inspectCreated: async () => identityEvidence,
      advance: async () => { throw new Error("interrupted before unit journal write"); } }),
    /interrupted before unit journal write/);
    assert.equal((await readCleanInstallJournal(interruptedPath)).phase, "units-intent");
    assert.ok((await stat(`${interruptedPath}.unit-install.lock`)).isFile());
    assert.equal((await recoverCompletedCleanUnits({ journalPath: interruptedPath,
      trustDir, configDir: interruptedDir, unitDirectory: interruptedUnitDir,
      inspectCreated: async () => identityEvidence,
      advance: options => advanceCleanInstallJournal({ ...options,
        inspectCreated: async () => identityEvidence }) })).phase, "units-ready");
    await assert.rejects(stat(`${interruptedPath}.unit-install.lock`), /ENOENT/);

    const dataRoot = path.join(workspaceParent, "installed-data-parent");
    await mkdir(dataRoot, { mode: 0o755 });
    const workEvidence = { uid: 4, gid: 4 };
    assert.equal((await advanceCleanInstallJournal({ journalPath,
      transactionId: journal.transactionId, expectedPhase: "units-ready",
      nextPhase: "data-intent", trustDir, configDir, unitDirectory, dataRoot,
      inspectCreated: async () => identityEvidence })).phase, "data-intent");
    assert.equal((await installCleanData({ journalPath, trustDir,
      configDir, unitDirectory, dataRoot,
      inspectCreated: async () => identityEvidence,
      inspectWork: async () => workEvidence,
      advance: options => advanceCleanInstallJournal({ ...options,
        inspectCreated: async () => identityEvidence,
        inspectData: input => inspectInstalledCleanData({ ...input,
          inspectWork: async () => workEvidence }) }) })).phase, "data-ready");
    const workData = path.join(dataRoot, "dp-beget-bridge");
    assert.equal((await stat(workData)).uid, workEvidence.uid);
    assert.equal((await stat(path.join(workData, "tmux"))).mode & 0o777, 0o700);
    await assert.rejects(stat(`${journalPath}.data-install.lock`), /ENOENT/);
    await writeFile(path.join(dataRoot, "dp-beget-bridge-agent", "unexpected"), "x");
    await assert.rejects(inspectInstalledCleanData({ dataRoot,
      plan: journal.identityPlan, identities: identityEvidence,
      inspectWork: async () => workEvidence }), /untrusted/);
    const dataLock = `${journalPath}.data-install.lock`;
    await writeFile(dataLock, `${journal.transactionId}\n`, { mode: 0o600 });
    await assert.rejects(recoverCompletedCleanData({ journalPath, trustDir,
      configDir, unitDirectory, dataRoot,
      inspectCreated: async () => identityEvidence,
      inspectData: input => inspectInstalledCleanData({ ...input,
        inspectWork: async () => workEvidence }) }), /untrusted/);
    assert.ok((await stat(dataLock)).isFile());
    await rm(path.join(dataRoot, "dp-beget-bridge-agent", "unexpected"));
    assert.equal((await recoverCompletedCleanData({ journalPath, trustDir,
      configDir, unitDirectory, dataRoot,
      inspectCreated: async () => identityEvidence,
      inspectData: input => inspectInstalledCleanData({ ...input,
        inspectWork: async () => workEvidence }) })).phase, "data-ready");
    await assert.rejects(stat(dataLock), /ENOENT/);

    const interruptedDataRoot = path.join(workspaceParent, "interrupted-data-parent");
    await mkdir(interruptedDataRoot, { mode: 0o755 });
    await advanceCleanInstallJournal({ journalPath: interruptedPath,
      transactionId: interrupted.transactionId, expectedPhase: "units-ready",
      nextPhase: "data-intent", trustDir, configDir: interruptedDir,
      unitDirectory: interruptedUnitDir, dataRoot: interruptedDataRoot,
      inspectCreated: async () => identityEvidence });
    await assert.rejects(installCleanData({ journalPath: interruptedPath,
      trustDir, configDir: interruptedDir, unitDirectory: interruptedUnitDir,
      dataRoot: interruptedDataRoot, inspectCreated: async () => identityEvidence,
      inspectWork: async () => workEvidence,
      advance: async () => { throw new Error("interrupted before data journal write"); } }),
    /interrupted before data journal write/);
    assert.equal((await readCleanInstallJournal(interruptedPath)).phase, "data-intent");
    assert.ok((await stat(`${interruptedPath}.data-install.lock`)).isFile());
    assert.equal((await recoverCompletedCleanData({ journalPath: interruptedPath,
      trustDir, configDir: interruptedDir, unitDirectory: interruptedUnitDir,
      dataRoot: interruptedDataRoot, inspectCreated: async () => identityEvidence,
      inspectData: input => inspectInstalledCleanData({ ...input,
        inspectWork: async () => workEvidence }),
      advance: options => advanceCleanInstallJournal({ ...options,
        inspectCreated: async () => identityEvidence,
        inspectData: input => inspectInstalledCleanData({ ...input,
          inspectWork: async () => workEvidence }) }) })).phase, "data-ready");
    await assert.rejects(stat(`${interruptedPath}.data-install.lock`), /ENOENT/);

    assert.equal((await advanceCleanInstallJournal({ journalPath,
      transactionId: journal.transactionId, expectedPhase: "data-ready",
      nextPhase: "release-root-intent", trustDir, configDir, unitDirectory, dataRoot,
      inspectCreated: async () => identityEvidence,
      inspectData: input => inspectInstalledCleanData({ ...input,
        inspectWork: async () => workEvidence }) })).phase, "release-root-intent");
    await assert.rejects(installCleanReleaseRoot({ journalPath, trustDir,
      configDir, unitDirectory, dataRoot,
      advance: async () => { throw new Error("interrupted before root journal write"); } }),
    /interrupted before root journal write/);
    assert.equal((await readCleanInstallJournal(journalPath)).phase, "release-root-intent");
    const rootLock = `${journalPath}.release-root-install.lock`;
    assert.ok((await stat(rootLock)).isFile());
    const recoverRoot = options => recoverCompletedCleanReleaseRoot({
      journalPath, trustDir, configDir, unitDirectory, dataRoot,
      inspectCreated: async () => identityEvidence,
      inspectData: input => inspectInstalledCleanData({ ...input,
        inspectWork: async () => workEvidence }), ...options });
    assert.equal((await recoverRoot({
      advance: options => advanceCleanInstallJournal({ ...options,
        inspectCreated: async () => identityEvidence,
        inspectData: input => inspectInstalledCleanData({ ...input,
          inspectWork: async () => workEvidence }) }) })).phase, "release-root-ready");
    assert.equal((await inspectCreatedCleanReleaseRoot({
      releaseRoot: args.releaseRoot })).releaseRoot, "private-empty");
    await assert.rejects(stat(rootLock), /ENOENT/);
    await writeFile(rootLock, `${journal.transactionId}\n`, { mode: 0o600 });
    const unexpected = path.join(args.releaseRoot, "releases", "unexpected");
    await writeFile(unexpected, "x");
    await assert.rejects(recoverRoot(), /unexpected contents/);
    assert.ok((await stat(rootLock)).isFile());
    await rm(unexpected);
    assert.equal((await recoverRoot()).phase, "release-root-ready");
    await assert.rejects(stat(rootLock), /ENOENT/);

    assert.equal((await advanceCleanInstallJournal({ journalPath,
      transactionId: journal.transactionId, expectedPhase: "release-root-ready",
      nextPhase: "promotion-intent", trustDir, configDir, unitDirectory, dataRoot,
      inspectCreated: async () => identityEvidence,
      inspectData: input => inspectInstalledCleanData({ ...input,
        inspectWork: async () => workEvidence }) })).phase, "promotion-intent");
    await assert.rejects(promoteCleanInstall({ journalPath, trustDir,
      configDir, unitDirectory, dataRoot,
      inspectCreated: async () => identityEvidence,
      inspectData: input => inspectInstalledCleanData({ ...input,
        inspectWork: async () => workEvidence }),
      advance: async () => { throw new Error("interrupted before promotion journal write"); } }),
    /interrupted before promotion journal write/);
    assert.equal((await readCleanInstallJournal(journalPath)).phase, "promotion-intent");
    const promotionLock = `${journalPath}.promotion-install.lock`;
    assert.ok((await stat(promotionLock)).isFile());
    const destination = path.join(args.releaseRoot, "releases", `${journal.version}-${journal.commit}`);
    const promotedPackage = path.join(destination, "package.json");
    const originalPackage = await readFile(promotedPackage);
    const changedPackage = Buffer.from(originalPackage);
    changedPackage[0] ^= 1;
    await writeFile(promotedPackage, changedPackage);
    const recoverPromotion = options => recoverCompletedCleanPromotion({ journalPath,
      trustDir, configDir, unitDirectory, dataRoot,
      inspectCreated: async () => identityEvidence,
      inspectData: input => inspectInstalledCleanData({ ...input,
        inspectWork: async () => workEvidence }), ...options });
    await assert.rejects(recoverPromotion(), /differs from signed archive/);
    assert.ok((await stat(promotionLock)).isFile());
    await writeFile(promotedPackage, originalPackage);
    const primitiveLock = path.join(args.releaseRoot, ".promotion.lock");
    await mkdir(primitiveLock, { mode: 0o700 });
    const promoted = await recoverPromotion({
      advance: options => advanceCleanInstallJournal({ ...options,
        inspectCreated: async () => identityEvidence,
        inspectData: input => inspectInstalledCleanData({ ...input,
          inspectWork: async () => workEvidence }) }) });
    assert.equal(promoted.phase, "promotion-ready");
    assert.equal(promoted.sha256, journal.artifactSha256);
    assert.equal((await inspectPromotedCleanRelease({ journal,
      trustDir })).release, "signed-inert");
    await assert.rejects(stat(path.join(args.releaseRoot, "current")), /ENOENT/);
    await assert.rejects(stat(`${journalPath}.promotion-install.lock`), /ENOENT/);
    await assert.rejects(stat(primitiveLock), /ENOENT/);
    await assert.rejects(inspectPromotedCleanRelease({ journal, trustDir,
      requireCurrent: true }), /ENOENT/);
    const current = path.join(args.releaseRoot, "current");
    await symlink(`releases/${journal.version}-${journal.commit}`, current);
    assert.equal((await inspectPromotedCleanRelease({ journal, trustDir,
      requireCurrent: true })).release, "signed-inert");
    await assert.rejects(inspectPromotedCleanRelease({ journal, trustDir }), /unexpected contents/);
    await rm(current);
    await symlink("releases/other", current);
    await assert.rejects(inspectPromotedCleanRelease({ journal, trustDir,
      requireCurrent: true }), /not the signed release/);
    await rm(current);
    assert.equal((await advanceCleanInstallJournal({ journalPath,
      transactionId: journal.transactionId, expectedPhase: "promotion-ready",
      nextPhase: "pointer-intent", trustDir, configDir, unitDirectory, dataRoot,
      inspectCreated: async () => identityEvidence,
      inspectData: input => inspectInstalledCleanData({ ...input,
        inspectWork: async () => workEvidence }) })).phase, "pointer-intent");
    await assert.rejects(installCleanPointer({ journalPath, trustDir,
      configDir, unitDirectory, dataRoot,
      inspectCreated: async () => identityEvidence,
      inspectData: input => inspectInstalledCleanData({ ...input,
        inspectWork: async () => workEvidence }),
      advance: async () => { throw new Error("interrupted before pointer journal write"); } }),
    /interrupted before pointer journal write/);
    assert.equal((await readCleanInstallJournal(journalPath)).phase, "pointer-intent");
    const pointerLock = `${journalPath}.pointer-install.lock`;
    assert.ok((await stat(pointerLock)).isFile());
    const recoverPointer = options => recoverCompletedCleanPointer({ journalPath,
      trustDir, configDir, unitDirectory, dataRoot,
      inspectCreated: async () => identityEvidence,
      inspectData: input => inspectInstalledCleanData({ ...input,
        inspectWork: async () => workEvidence }), ...options });
    await rm(current);
    await symlink("releases/other", current);
    await assert.rejects(recoverPointer(), /not the signed release/);
    assert.ok((await stat(pointerLock)).isFile());
    await rm(current);
    await symlink(`releases/${journal.version}-${journal.commit}`, current);
    const pointer = await recoverPointer({
      advance: options => advanceCleanInstallJournal({ ...options,
        inspectCreated: async () => identityEvidence,
        inspectData: input => inspectInstalledCleanData({ ...input,
          inspectWork: async () => workEvidence }) }) });
    assert.equal(pointer.phase, "pointer-ready");
    assert.equal(pointer.current, `releases/${journal.version}-${journal.commit}`);
    assert.equal((await inspectPromotedCleanRelease({ journal, trustDir,
      requireCurrent: true })).release, "signed-inert");
    await assert.rejects(stat(`${journalPath}.pointer-install.lock`), /ENOENT/);
    const systemdState = (unit, active = "inactive") => {
      const index = CLEAN_INSTALL_UNIT_NAMES.indexOf(unit);
      const loaded = index < 3;
      const user = [journal.identityPlan.workUser, journal.identityPlan.agentUser,
        journal.identityPlan.mcpUser][index] || "";
      const group = [journal.identityPlan.ipcGroup, journal.identityPlan.agentUser,
        journal.identityPlan.mcpUser][index] || "";
      return `LoadState=${loaded ? "loaded" : "not-found"}\n` +
        `FragmentPath=${loaded ? path.join(unitDirectory, unit) : ""}\n` +
        `DropInPaths=\nActiveState=${active}\n` +
        `UnitFileState=${loaded ? "disabled" : ""}\n` +
        `WorkingDirectory=${loaded ? current : ""}\nUser=${user}\nGroup=${group}\n` +
        `KillMode=${index === 0 ? "process" : "control-group"}\n`;
    };
    const inspectSystemd = showUnit => inspectCleanSystemdBoundary({ journalPath,
      trustDir, unitDirectory, showUnit,
      inspectListeners: async () => ({ directPorts: "unoccupied" }) });
    assert.deepEqual(await inspectSystemd(unit => systemdState(unit)), {
      localSystemd: "inactive-bound", directPorts: "unoccupied", publicIngress: "unproven"
    });
    await assert.rejects(inspectSystemd(unit => systemdState(unit,
      unit === "dp-beget-agent.service" ? "active" : "inactive")), /active or overridden/);
    assert.equal((await advanceCleanInstallJournal({ journalPath,
      transactionId: journal.transactionId, expectedPhase: "pointer-ready",
      nextPhase: "systemd-intent", trustDir, configDir, unitDirectory, dataRoot,
      inspectCreated: async () => identityEvidence,
      inspectData: input => inspectInstalledCleanData({ ...input,
        inspectWork: async () => workEvidence }) })).phase, "systemd-intent");
    const inspectInactive = showUnit => inspectCleanSystemdInactivity({ showUnit,
      inspectListeners: async () => ({ directPorts: "unoccupied" }) });
    let reloadCalls = 0;
    const loadOptions = { journalPath, trustDir, configDir, unitDirectory, dataRoot,
      inspectInactive: () => inspectInactive(unit => systemdState(unit)),
      inspectBoundary: () => inspectSystemd(unit => systemdState(unit)),
      reload: async () => { reloadCalls++; },
      advance: options => advanceCleanInstallJournal({ ...options,
        inspectCreated: async () => identityEvidence,
        inspectData: input => inspectInstalledCleanData({ ...input,
          inspectWork: async () => workEvidence }),
        inspectSystemd: () => inspectSystemd(unit => systemdState(unit)) }) };
    await assert.rejects(loadCleanSystemdUnits({ ...loadOptions,
      inspectInactive: () => inspectInactive(unit => systemdState(unit,
        unit === "dp-beget-mcp.service" ? "active" : "inactive")) }), /active or overridden/);
    assert.equal(reloadCalls, 0);
    await assert.rejects(loadCleanSystemdUnits({ ...loadOptions,
      advance: async () => { throw new Error("interrupted before systemd journal write"); } }),
    /interrupted before systemd journal write/);
    assert.equal(reloadCalls, 1);
    assert.equal((await readCleanInstallJournal(journalPath)).phase, "systemd-intent");
    const systemdLock = `${journalPath}.systemd-install.lock`;
    assert.ok((await stat(systemdLock)).isFile());
    const recoverSystemd = options => recoverCompletedCleanSystemd({ journalPath,
      trustDir, configDir, unitDirectory, dataRoot,
      inspectCreated: async () => identityEvidence,
      inspectData: input => inspectInstalledCleanData({ ...input,
        inspectWork: async () => workEvidence }), ...options });
    await assert.rejects(recoverSystemd({
      inspectSystemd: () => inspectSystemd(unit => systemdState(unit,
        unit === "dp-beget-agent.service" ? "active" : "inactive")) }), /active or overridden/);
    assert.ok((await stat(systemdLock)).isFile());
    assert.equal((await recoverSystemd({
      inspectSystemd: () => inspectSystemd(unit => systemdState(unit)),
      advance: loadOptions.advance })).phase, "systemd-ready");
    await assert.rejects(stat(systemdLock), /ENOENT/);
    const admissionParent = await mkdtemp("/var/lib/dp-clean-admission-test-");
    t.after(() => rm(admissionParent, { recursive: true, force: true }));
    await chmod(admissionParent, 0o755);
    const admissionFlag = path.join(admissionParent, "maintenance", "admission-paused");
    const inspectAdmissionTarget = async () => {
      await assert.rejects(stat(admissionFlag), { code: "ENOENT" });
      return { admission: "absent" };
    };
    const inspectPaused = () => verifyAdmissionPause({ flag: admissionFlag });
    assert.equal((await advanceCleanInstallJournal({ journalPath,
      transactionId: journal.transactionId, expectedPhase: "systemd-ready",
      nextPhase: "admission-intent", trustDir, configDir, unitDirectory, dataRoot,
      inspectCreated: async () => identityEvidence,
      inspectData: input => inspectInstalledCleanData({ ...input,
        inspectWork: async () => workEvidence }),
      inspectSystemd: () => inspectSystemd(unit => systemdState(unit)),
      inspectAdmissionTarget })).phase, "admission-intent");
    await assert.rejects(installCleanAdmissionPause({ journalPath, trustDir,
      configDir, unitDirectory, dataRoot, inspectTarget: inspectAdmissionTarget,
      inspectSystemd: () => inspectSystemd(unit => systemdState(unit)),
      pause: async ({ flag }) => {
        assert.equal(flag, DEFAULT_ADMISSION_PAUSE_PATH);
        return pauseAdmission({ flag: admissionFlag });
      },
      inspectPaused: async ({ flag }) => {
        assert.equal(flag, DEFAULT_ADMISSION_PAUSE_PATH);
        return inspectPaused();
      },
      advance: async () => { throw new Error("interrupted before admission journal write"); } }),
    /interrupted before admission journal write/);
    assert.equal((await readCleanInstallJournal(journalPath)).phase, "admission-intent");
    const admissionLock = `${journalPath}.admission-install.lock`;
    assert.ok((await stat(admissionLock)).isFile());
    const originalAdmission = await readFile(admissionFlag);
    await writeFile(admissionFlag, "changed admission flag\n");
    const recoverAdmission = options => recoverCompletedCleanAdmission({ journalPath,
      trustDir, configDir, unitDirectory, dataRoot,
      inspectCreated: async () => identityEvidence,
      inspectData: input => inspectInstalledCleanData({ ...input,
        inspectWork: async () => workEvidence }),
      inspectSystemd: () => inspectSystemd(unit => systemdState(unit)),
      inspectPaused, ...options });
    await assert.rejects(recoverAdmission(), /Unexpected admission pause flag content/);
    assert.ok((await stat(admissionLock)).isFile());
    await writeFile(admissionFlag, originalAdmission);
    const paused = await recoverAdmission({
      advance: options => advanceCleanInstallJournal({ ...options,
        inspectCreated: async () => identityEvidence,
        inspectData: input => inspectInstalledCleanData({ ...input,
          inspectWork: async () => workEvidence }),
        inspectSystemd: () => inspectSystemd(unit => systemdState(unit)),
        inspectPaused }) });
    assert.equal(paused.phase, "admission-ready");
    assert.equal(await isAdmissionPaused(admissionFlag), true);
    await assert.rejects(stat(admissionLock), /ENOENT/);
    const failedStartupPath = path.join(workspaceParent, "failed-startup-journal.json");
    await writeFile(failedStartupPath, await readFile(journalPath), { mode: 0o600 });
    const closedIngress = async () => ({ publicIngress: "closed-exclusive" });
    const healthy = async () => ({ drained: true, services: 3 });
    const started = new Set();
    const inactive = async () => {
      assert.equal(started.size, 0);
      return { localSystemd: "inactive-bound" };
    };
    const running = async () => {
      assert.deepEqual([...started], ["dp-beget-session-host.service",
        "dp-beget-agent.service", "dp-beget-mcp.service"]);
      return { localSystemd: "active-bound" };
    };
    const advanceStartup = options => advanceCleanInstallJournal({ ...options,
      inspectCreated: async () => identityEvidence,
      inspectData: input => inspectInstalledCleanData({ ...input,
        inspectWork: async () => workEvidence }),
      inspectSystemd: inactive, inspectPaused,
      inspectClosedIngress: closedIngress, inspectRunning: running,
      inspectHealth: healthy });
    for (const filename of [journalPath, failedStartupPath]) {
      assert.equal((await advanceStartup({ journalPath: filename,
        transactionId: journal.transactionId, expectedPhase: "admission-ready",
        nextPhase: "startup-intent", trustDir, configDir, unitDirectory, dataRoot })).phase,
      "startup-intent");
    }
    const startOptions = filename => ({ journalPath: filename, trustDir,
      configDir, unitDirectory, dataRoot, inspectInactive: inactive,
      inspectCreated: async () => identityEvidence,
      inspectData: input => inspectInstalledCleanData({ ...input,
        inspectWork: async () => workEvidence }),
      inspectRunning: running, inspectPaused, inspectClosedIngress: closedIngress,
      inspectHealth: healthy, advance: advanceStartup,
      startUnit: async unit => { started.add(unit); },
      stopUnit: async unit => { started.delete(unit); } });
    await assert.rejects(startCleanLocalServices({ ...startOptions(journalPath),
      inspectClosedIngress: undefined }), /verified closed public route/);
    await assert.rejects(stat(`${journalPath}.startup-install.lock`), /ENOENT/);
    await assert.rejects(startCleanLocalServices({ ...startOptions(failedStartupPath),
      startUnit: async unit => {
        started.add(unit);
        if (unit === "dp-beget-agent.service") throw new Error("partial startup");
      } }), /partial startup/);
    assert.equal(started.size, 0);
    assert.equal((await readCleanInstallJournal(failedStartupPath)).phase, "startup-intent");
    const failedStartupLock = `${failedStartupPath}.startup-install.lock`;
    assert.ok((await stat(failedStartupLock)).isFile());
    assert.equal(await isAdmissionPaused(admissionFlag), true);
    const recoverStartup = options => recoverCleanLocalStartup({
      journalPath: failedStartupPath, trustDir, configDir, unitDirectory, dataRoot,
      inspectCreated: async () => identityEvidence,
      inspectData: input => inspectInstalledCleanData({ ...input,
        inspectWork: async () => workEvidence }),
      inspectInactive: inactive, inspectRunning: running,
      inspectPaused, inspectClosedIngress: closedIngress,
      inspectHealth: healthy, advance: advanceStartup, ...options });
    const journalTransitionLock = `${failedStartupPath}.lock`;
    await writeFile(journalTransitionLock, "unresolved transition\n", { mode: 0o600 });
    await assert.rejects(recoverStartup(), /unresolved lock/);
    assert.ok((await stat(failedStartupLock)).isFile());
    await rm(journalTransitionLock);
    await assert.rejects(recoverStartup({
      inspectClosedIngress: async () => ({ publicIngress: "unproven" }) }),
    /closed route are unproven/);
    assert.ok((await stat(failedStartupLock)).isFile());
    started.add("dp-beget-session-host.service");
    await assert.rejects(recoverStartup());
    assert.ok((await stat(failedStartupLock)).isFile());
    started.clear();
    assert.deepEqual((await recoverStartup()).phase, "startup-intent");
    await assert.rejects(stat(failedStartupLock), /ENOENT/);
    // Simulate a process dying after all starts but before the journal write.
    for (const unit of ["dp-beget-session-host.service", "dp-beget-agent.service",
      "dp-beget-mcp.service"]) started.add(unit);
    await writeFile(failedStartupLock, `${journal.transactionId}\n`, { mode: 0o600 });
    assert.equal((await recoverStartup()).phase, "startup-ready");
    await assert.rejects(stat(failedStartupLock), /ENOENT/);
    started.clear();
    assert.equal((await startCleanLocalServices(startOptions(journalPath))).phase, "startup-ready");
    assert.deepEqual([...started], ["dp-beget-session-host.service",
      "dp-beget-agent.service", "dp-beget-mcp.service"]);
    await assert.rejects(stat(`${journalPath}.startup-install.lock`), /ENOENT/);
  }
  const secondJournalPath = path.join(workspaceParent, "interrupted-install-journal.json");
  const secondJournal = await startCleanInstallJournal({ journalPath: secondJournalPath,
    workspace: args.workspace, manifestSha256: result.manifestSha256,
    releaseRoot: args.releaseRoot, trustDir });
  const failedJournalPath = path.join(workspaceParent, "partial-identities-journal.json");
  const failed = await startCleanInstallJournal({ journalPath: failedJournalPath,
    workspace: args.workspace, manifestSha256: result.manifestSha256,
    releaseRoot: args.releaseRoot, trustDir });
  await advanceCleanInstallJournal({ journalPath: failedJournalPath,
    transactionId: failed.transactionId, expectedPhase: "prepared",
    nextPhase: "identities-intent", trustDir });
  await assert.rejects(installCleanIdentities({ journalPath: failedJournalPath, trustDir,
    inspectAvailable: async () => {},
    addGroup: async () => { throw new Error("injected account tool failure"); } }),
  /injected account tool failure/);
  assert.equal((await readCleanInstallJournal(failedJournalPath)).phase, "identities-intent");
  assert.ok((await stat(`${failedJournalPath}.identity-install.lock`)).isFile());
  await assert.rejects(recoverCompletedCleanIdentities({ journalPath: failedJournalPath,
    trustDir }), /getent|Command failed/);
  assert.ok((await stat(`${failedJournalPath}.identity-install.lock`)).isFile());
  await assert.rejects(stat(`${failedJournalPath}.identity-recovery.lock`), /ENOENT/);

  const completedJournalPath = path.join(workspaceParent, "completed-identities-journal.json");
  const completed = await startCleanInstallJournal({ journalPath: completedJournalPath,
    workspace: args.workspace, manifestSha256: result.manifestSha256,
    releaseRoot: args.releaseRoot, trustDir });
  await advanceCleanInstallJournal({ journalPath: completedJournalPath,
    transactionId: completed.transactionId, expectedPhase: "prepared",
    nextPhase: "identities-intent", trustDir });
  await assert.rejects(installCleanIdentities({ journalPath: completedJournalPath, trustDir,
    inspectAvailable: async () => {}, addGroup: async () => {}, addUser: async () => {},
    advance: async () => { throw new Error("interrupted before journal write"); } }),
  /interrupted before journal write/);
  assert.equal((await readCleanInstallJournal(completedJournalPath)).phase, "identities-intent");
  const recovered = await recoverCompletedCleanIdentities({ journalPath: completedJournalPath,
    trustDir, inspectCreated: async () => ({ identities: "journal-bound" }),
    advance: options => advanceCleanInstallJournal({ ...options,
      inspectCreated: async () => ({ identities: "journal-bound" }) }) });
  assert.equal(recovered.phase, "identities-ready");
  await assert.rejects(stat(`${completedJournalPath}.identity-install.lock`), /ENOENT/);
  await assert.rejects(stat(`${completedJournalPath}.identity-recovery.lock`), /ENOENT/);
  await writeFile(`${completedJournalPath}.identity-install.lock`, "wrong transaction\n",
    { mode: 0o600 });
  await assert.rejects(recoverCompletedCleanIdentities({ journalPath: completedJournalPath,
    trustDir, inspectCreated: async () => ({ identities: "journal-bound" }) }),
  /lock does not match/);
  await writeFile(`${completedJournalPath}.identity-install.lock`, `${completed.transactionId}\n`);
  assert.equal((await recoverCompletedCleanIdentities({ journalPath: completedJournalPath,
    trustDir, inspectCreated: async () => ({ identities: "journal-bound" }) })).phase,
  "identities-ready");
  await assert.rejects(recoverCompletedCleanIdentities({ journalPath: completedJournalPath,
    trustDir }), /ENOENT/);
  await assert.rejects(prepareCleanInstall(args), /EEXIST/);
  assert.ok((await stat(unit)).isFile(), "an existing candidate cannot be cleaned up by a failed retry");
  await assert.rejects(prepareCleanInstall({ ...args,
    workspace: path.join(workspaceParent, "failed-candidate"),
    stageUnits: async () => { throw new Error("injected staging failure"); } }),
  /injected staging failure/);
  await assert.rejects(stat(path.join(workspaceParent, "failed-candidate")), /ENOENT/);
  await assert.rejects(prepareCleanInstall({ ...args,
    workspace: path.join(workspaceParent, "changed-candidate"),
    inspect: async () => ({ candidate: { sha256: "a".repeat(64) } }) }),
  /changed after clean-install preflight/);
  await assert.rejects(stat(path.join(workspaceParent, "changed-candidate")), /ENOENT/);
  const configFile = path.join(args.workspace, "clean-install", "config", "mcp.env");
  await writeFile(configFile, (await readFile(configFile, "utf8")) + "DP_LOG_LEVEL=debug\n");
  if (process.env.DP_TEST_REAL_CHOWN === "1") {
    await assert.rejects(inspectInstalledCleanConfig({ configDir, workspace: args.workspace,
      manifestSha256: result.manifestSha256, trustDir,
      identityPlan: journal.identityPlan, identities: identityEvidence }), /files changed/);
  }
  await assert.rejects(verifyCleanInstallManifest({ workspace: args.workspace, trustDir,
    manifestSha256: result.manifestSha256 }), /files changed/);
  await assert.rejects(advanceCleanInstallJournal({ journalPath: secondJournalPath,
    transactionId: secondJournal.transactionId, expectedPhase: "prepared",
    nextPhase: "identities-intent", trustDir }), /files changed/);
  assert.equal((await readCleanInstallJournal(secondJournalPath)).phase, "prepared");
  await assert.rejects(advanceCleanInstallJournal({ journalPath: secondJournalPath,
    transactionId: secondJournal.transactionId, expectedPhase: "prepared",
    nextPhase: "identities-intent", trustDir }), /EEXIST/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { inspectInstalledCleanConfig } from "../scripts/release/inspect-installed-clean-config.mjs";
import { inspectInstalledCleanUnits } from "../scripts/release/inspect-installed-clean-units.mjs";
import { recoverCompletedCleanIdentities } from "../scripts/release/recover-completed-clean-identities.mjs";
import { recoverCompletedCleanConfig } from "../scripts/release/recover-completed-clean-config.mjs";
import { recoverCompletedCleanUnits } from "../scripts/release/recover-completed-clean-units.mjs";
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
    workspace: path.join(workspaceParent, "new-candidate"), releaseRoot: "/opt/dp-versions",
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
  assert.match(await readFile(unit, "utf8"), /WorkingDirectory=\/opt\/dp-versions\/current\n/);
  assert.equal((await stat(unit)).mode & 0o777, 0o600);
  const journalPath = path.join(workspaceParent, "clean-install-journal.json");
  const journal = await startCleanInstallJournal({ journalPath, workspace: args.workspace,
    manifestSha256: result.manifestSha256, releaseRoot: args.releaseRoot, trustDir });
  assert.equal(journal.phase, "prepared");
  assert.deepEqual(journal.identityPlan, {
    workUser: "operator", workGroup: "operator", ipcGroup: "dp-ipc",
    agentUser: "dp-agent", mcpUser: "dp-mcp", allowedRoot: "/srv/operator",
    releaseRoot: "/opt/dp-versions", domain: "bridge.example.com"
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
    agentGid: 2, mcpGid: 3 };
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

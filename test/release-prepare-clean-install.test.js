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
  await assert.rejects(advanceCleanInstallJournal({ journalPath,
    transactionId: journal.transactionId, expectedPhase: "identities-intent",
    nextPhase: "identities-ready", trustDir }), /transition rejected/);
  const secondJournalPath = path.join(workspaceParent, "interrupted-install-journal.json");
  const secondJournal = await startCleanInstallJournal({ journalPath: secondJournalPath,
    workspace: args.workspace, manifestSha256: result.manifestSha256,
    releaseRoot: args.releaseRoot, trustDir });
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

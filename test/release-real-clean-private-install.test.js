import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildArtifact } from "../scripts/release/build-artifact.mjs";
import { signManifest } from "../scripts/release/sign-manifest.mjs";
import { pinReleaseKey } from "../scripts/release/pin-release-key.mjs";
import { prepareCleanInstall } from "../scripts/release/prepare-clean-install.mjs";
import { preflightCleanInstall, CLEAN_INSTALL_UNIT_NAMES } from "../scripts/release/preflight-clean-install.mjs";
import { installCleanPrivateRuntime } from "../scripts/release/install-clean-private-runtime.mjs";
import { readCleanInstallJournal } from "../scripts/release/clean-install-journal.mjs";
import { inspectCleanSystemdBoundary } from "../scripts/release/inspect-clean-systemd-boundary.mjs";
import { verifyAdmissionPause } from "../scripts/release/admission-pause.mjs";

const exec = promisify(execFile);
const systemctl = (...args) => exec("systemctl", args, { timeout: 20000, maxBuffer: 4096 });

test("OPS-01/05: real signed private installation reaches inactive/paused state without fake mutations", async t => {
  if (process.env.DP_TEST_REAL_PRIVATE_INSTALL !== "1" || process.platform !== "linux" || process.getuid?.() !== 0) {
    t.skip("requires explicitly enabled disposable root Linux installation CI"); return;
  }
  const ownerUid = Number(process.env.SUDO_UID), ownerGid = Number(process.env.SUDO_GID);
  assert.ok(Number.isSafeInteger(ownerUid) && ownerUid > 0 && Number.isSafeInteger(ownerGid) && ownerGid > 0);
  const workUser = (await exec("getent", ["passwd", String(ownerUid)])).stdout.trim().split(":")[0];
  const workGroup = (await exec("getent", ["group", String(ownerGid)])).stdout.trim().split(":")[0];
  const suffix = randomBytes(5).toString("hex");
  const agentUser = `dpci_a_${suffix}`, mcpUser = `dpci_m_${suffix}`, ipcGroup = `dpci_i_${suffix}`;
  const core = CLEAN_INSTALL_UNIT_NAMES.slice(0, 3);
  const canonical = ["/etc/dp-beget-bridge", "/var/lib/dp-beget-bridge", "/var/lib/dp-beget-bridge-agent",
    "/var/lib/dp-beget-bridge-mcp", "/var/lib/dp-beget-bridge-maintenance"];
  for (const filename of canonical) await assert.rejects(lstat(filename), { code: "ENOENT" });
  for (const unit of CLEAN_INSTALL_UNIT_NAMES) {
    assert.equal((await systemctl("show", unit, "--property=LoadState", "--value")).stdout.trim(), "not-found");
    await assert.rejects(lstat(`/etc/systemd/system/${unit}`), { code: "ENOENT" });
    await assert.rejects(lstat(`/etc/systemd/system/${unit}.d`), { code: "ENOENT" });
  }
  for (const name of [agentUser, mcpUser, ipcGroup]) {
    await assert.rejects(exec("getent", ["group", name]), error => error.code === 2);
  }
  const base = await mkdtemp("/var/lib/dp-ci-private-install-");
  // GitHub runners preinstall user-writable tools under /opt. Keep their
  // existing permissions intact and use a genuinely root-owned parent.
  const releaseRoot = `/var/lib/dp-ci-release-${suffix}`, allowedRoot = `/srv/dp-ci-work-${suffix}`;
  await assert.rejects(lstat(releaseRoot), { code: "ENOENT" });
  await assert.rejects(lstat(allowedRoot), { code: "ENOENT" });
  t.after(async () => {
    // This runner was proven empty at fixture entry; no application service
    // is ever started and no terminal/user content exists in these paths.
    for (const unit of core.toReversed()) await systemctl("stop", unit).catch(() => {});
    for (const unit of core) await rm(`/etc/systemd/system/${unit}`, { force: true });
    await systemctl("daemon-reload");
    for (const filename of [...canonical, releaseRoot, allowedRoot, base]) await rm(filename, { recursive: true, force: true });
    for (const name of [mcpUser, agentUser]) await exec("userdel", ["--", name]).catch(error => { if (error.code !== 6) throw error; });
    for (const name of [mcpUser, agentUser, ipcGroup]) await exec("groupdel", ["--", name]).catch(error => { if (error.code !== 6) throw error; });
  });
  await chmod(base, 0o700);
  await mkdir(allowedRoot, { mode: 0o700 });
  await chown(allowedRoot, ownerUid, ownerGid);
  const commit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  const built = await buildArtifact({ commit, outputDir: path.join(base, "artifact") });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicBytes = publicKey.export({ format: "pem", type: "spki" });
  const publicFile = path.join(base, "public.pem"), privateFile = path.join(base, "private.pem");
  await writeFile(publicFile, publicBytes, { mode: 0o600 });
  await writeFile(privateFile, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const signature = path.join(base, "artifact", "manifest.sig");
  await signManifest({ ...built, privateKey: privateFile, signature });
  const workspaceParent = path.join(base, "private");
  await mkdir(workspaceParent, { mode: 0o700 });
  const trustDir = path.join(workspaceParent, "trust");
  await pinReleaseKey({ source: publicFile, expectedSha256: createHash("sha256").update(publicBytes).digest("hex"), trustDir });
  const domain = "bridge.example.invalid", expectedIp = "1.1.1.1";
  const inputs = { ...built, signature, trustDir, workspaceParent,
    workspace: path.join(workspaceParent, "candidate"), releaseRoot, allowedRoot,
    workUser, workGroup, agentUser, mcpUser, ipcGroup, domain, expectedIp };
  // Only the external DNS/TLS prerequisite is simulated in this private
  // installation fixture. Trust, signatures, extraction, actual npm ci,
  // capacity, NSS, accounts, ownership, units, pointers and manager are real.
  const prepared = await prepareCleanInstall({ ...inputs,
    inspect: args => preflightCleanInstall({ ...args,
      inspectHost: async () => ({ domain, expectedIp, dns: "pass", tls: "pass" }) }) });
  const journalPath = path.join(workspaceParent, "installation.json");
  const controller = { journalPath, workspace: inputs.workspace,
    manifestSha256: prepared.manifestSha256, releaseRoot, trustDir };
  const result = await installCleanPrivateRuntime(controller);
  assert.equal(result.phase, "admission-ready");
  assert.equal(result.localServices, "inactive");
  assert.equal(result.admission, "paused");
  assert.equal(result.publicIngress, "unproven");
  assert.equal((await readCleanInstallJournal(journalPath)).commit, commit);
  assert.equal((await inspectCleanSystemdBoundary({ journalPath, trustDir })).localSystemd, "inactive-bound");
  assert.equal((await verifyAdmissionPause()).paused, true);
  assert.equal((await lstat(path.join(releaseRoot, "current"))).isSymbolicLink(), true);
  await assert.rejects(installCleanPrivateRuntime(controller), /fresh journal/);
  assert.equal((await readCleanInstallJournal(journalPath)).phase, "admission-ready");
  t.diagnostic("Real signed artifact, dependencies, identities, config, data, promotion, pointer, systemd and admission installation passed; public DNS/TLS simulated; no service startup");
});

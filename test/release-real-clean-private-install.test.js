import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { buildArtifact } from "../scripts/release/build-artifact.mjs";
import { signManifest } from "../scripts/release/sign-manifest.mjs";
import { pinReleaseKey } from "../scripts/release/pin-release-key.mjs";
import { prepareCleanInstall } from "../scripts/release/prepare-clean-install.mjs";
import { preflightCleanInstall, CLEAN_INSTALL_UNIT_NAMES } from "../scripts/release/preflight-clean-install.mjs";
import { installCleanPrivateRuntime } from "../scripts/release/install-clean-private-runtime.mjs";
import { advanceCleanInstallJournal, readCleanInstallJournal, requireCleanClosedIngress } from "../scripts/release/clean-install-journal.mjs";
import { inspectCleanSystemdBoundary } from "../scripts/release/inspect-clean-systemd-boundary.mjs";
import { verifyAdmissionPause } from "../scripts/release/admission-pause.mjs";
import { startCleanLocalServices } from "../scripts/release/start-clean-local-services.mjs";
import { recoverCleanLocalStartup } from "../scripts/release/recover-clean-local-startup.mjs";
import { inspectCleanStartupData, inspectInstalledCleanData } from "../scripts/release/clean-install-data-directories.mjs";
import { inspectCreatedCleanIdentities } from "../scripts/release/inspect-clean-install-created-identities.mjs";
import { localReleaseHealthProbes, waitForAdmissionDrain } from "../scripts/release/wait-admission-drain.mjs";
import { inspectCleanInstallAuthProfile } from "../scripts/release/clean-install-auth-profile.mjs";
import { inspectInitializedCleanOwner } from "../scripts/release/clean-install-owner-data.mjs";
import { installCleanOwner } from "../scripts/release/install-clean-owner.mjs";
import { recoverCompletedCleanOwner } from "../scripts/release/recover-completed-clean-owner.mjs";
import { installCleanPrivate } from "../scripts/release/install-clean-private.mjs";
import { inspectCleanInstallRoute } from "../scripts/release/inspect-clean-install-route.mjs";
import { inspectCleanWorkspace } from "../scripts/release/clean-install-workspace.mjs";
import { rehearseCleanPrivateAutonomy } from "../scripts/integration/clean-private-autonomy.mjs";
import { startCleanProtected } from "../scripts/release/start-clean-protected.mjs";

const exec = promisify(execFile);
const systemctl = (...args) => exec("systemctl", args, { timeout: 20000, maxBuffer: 4096 });

test("OPS-01/05: real signed private installation reaches inactive/paused state without fake mutations", async t => {
  if (process.env.DP_TEST_REAL_PRIVATE_INSTALL !== "1" || process.platform !== "linux" || process.getuid?.() !== 0) {
    t.skip("requires explicitly enabled disposable root Linux installation CI"); return;
  }
  const joinedCaddy = process.env.DP_TEST_CADDY_INSTALL_ROUTE_JSON
    ? JSON.parse(process.env.DP_TEST_CADDY_INSTALL_ROUTE_JSON) : null;
  if (joinedCaddy) {
    assert.equal(process.env.DP_TEST_REAL_CADDY_PROCESS, "1");
    assert.equal(process.env.DP_TEST_REAL_CLEAN_PRIVATE_ENTRY, "1");
    assert.notEqual(process.env.DP_TEST_REAL_CLEAN_STARTUP, "1");
    assert.match(joinedCaddy.namespacePath, /^\/run\/netns\/dp-clean-caddy-[a-z0-9-]+$/);
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
  await assert.rejects(lstat("/run/dp-beget-bridge"), { code: "ENOENT" });
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
    // This runner was proven empty at fixture entry. The optional startup
    // rehearsal admits only the optional disposable autonomy session.
    for (const unit of core.toReversed()) await systemctl("stop", unit).catch(() => {});
    for (const unit of core) await rm(`/etc/systemd/system/${unit}`, { force: true });
    await systemctl("daemon-reload");
    for (const filename of [...canonical, "/run/dp-beget-bridge", releaseRoot, allowedRoot, base]) await rm(filename, { recursive: true, force: true });
    for (const unit of core) await systemctl("reset-failed", unit).catch(() => {});
    for (const name of [mcpUser, agentUser]) await exec("userdel", ["--", name]).catch(error => { if (error.code !== 6) throw error; });
    for (const name of [mcpUser, agentUser, ipcGroup]) await exec("groupdel", ["--", name]).catch(error => { if (error.code !== 6) throw error; });
  });
  await chmod(base, 0o700);
  await mkdir(allowedRoot, { mode: 0o700 });
  await chown(allowedRoot, ownerUid, ownerGid);
  const canary = path.join(allowedRoot, "existing-private-canary.txt");
  await writeFile(canary, "private-existing-workspace-fixture\n", { mode: 0o600 });
  await chown(canary, ownerUid, ownerGid);
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
    workUser, workGroup, agentUser, mcpUser, ipcGroup, domain, expectedIp,
    ...(process.env.DP_TEST_REAL_CLEAN_OAUTH_STAGING === "1"
      ? { authMode: "oauth", ownerId: "owner-ci", executionProfile: "full-shell" } : {}) };
  // Only the external DNS/TLS prerequisite is simulated in this private
  // installation fixture. Trust, signatures, extraction, actual npm ci,
  // capacity, NSS, accounts, ownership, units, pointers and manager are real.
  const journalPath = path.join(workspaceParent, "installation.json");
  const prepare = args => prepareCleanInstall({ ...args,
    inspect: request => preflightCleanInstall({ ...request,
      inspectHost: async () => ({ domain, expectedIp, dns: "pass", tls: "pass" }) }) });
  const useEntry = process.env.DP_TEST_REAL_CLEAN_PRIVATE_ENTRY === "1";
  let prepared, result;
  if (useEntry) {
    assert.equal(process.env.DP_TEST_REAL_CLEAN_OAUTH_STAGING, "1");
    assert.equal(process.env.DP_TEST_REAL_CLEAN_OAUTH_COMPOSED, "1");
    const requestPath = path.join(workspaceParent, "private-request.json");
    const request = { format: "dp-beget-clean-private-request-v1", journalPath };
    for (const key of ["artifact", "manifest", "signature", "trustDir", "domain", "expectedIp",
      "workUser", "workGroup", "agentUser", "mcpUser", "ipcGroup", "allowedRoot", "workspaceParent",
      "workspace", "releaseRoot", "ownerId", "executionProfile"]) request[key] = inputs[key];
    await writeFile(requestPath, JSON.stringify(request) + "\n", { mode: 0o600, flag: "wx" });
    const options = { requestPath, prepare: async args => { prepared = await prepare(args); return prepared; } };
    result = await installCleanPrivate(options);
    await assert.rejects(installCleanPrivate(options), /fresh journal/);
    t.diagnostic("Actual protected request reader, signed preparation and owner controller composed through one private entry; fresh-only replay rejected");
  } else {
    prepared = await prepare(inputs);
  }
  const controller = { journalPath, workspace: inputs.workspace,
    manifestSha256: prepared.manifestSha256, releaseRoot, trustDir,
    initializeOwner: process.env.DP_TEST_REAL_CLEAN_OAUTH_COMPOSED === "1" };
  if (!useEntry) result = await installCleanPrivateRuntime(controller);
  const installedPhase = controller.initializeOwner ? "owner-ready" : "admission-ready";
  assert.equal(result.phase, installedPhase);
  assert.equal(result.localServices, "inactive");
  assert.equal((await lstat(allowedRoot)).mode & 0o7777, 0o2770);
  assert.equal((await lstat(canary)).mode & 0o7777, 0o600);
  assert.equal((await lstat(canary)).uid, ownerUid);
  assert.equal((await lstat(canary)).gid, ownerGid);
  const workspaceJournal = await readCleanInstallJournal(journalPath);
  const workspaceInputs = { identityPlan: workspaceJournal.identityPlan,
    identities: await inspectCreatedCleanIdentities({ plan: workspaceJournal.identityPlan,
      transactionId: workspaceJournal.transactionId }) };
  assert.equal((await inspectCleanWorkspace(workspaceInputs)).workspace, "shared-private");
  await chmod(allowedRoot, 0o2775);
  await assert.rejects(inspectCleanWorkspace(workspaceInputs), /shared privately/);
  await chmod(allowedRoot, 0o2770);
  await exec("setfacl", ["-m", "u:0:rwx", "--", allowedRoot]);
  await assert.rejects(inspectCleanWorkspace(workspaceInputs), /extended\/default ACLs/);
  await exec("setfacl", ["-b", "--", allowedRoot]);
  await exec("setfacl", ["-m", "d:u::rwx,d:g::rwx,d:o::---", "--", allowedRoot]);
  await assert.rejects(inspectCleanWorkspace(workspaceInputs), /extended\/default ACLs/);
  await exec("setfacl", ["-k", "--", allowedRoot]);
  assert.equal((await inspectCleanWorkspace(workspaceInputs)).workspace, "shared-private");
  t.diagnostic("Actual journaled private workspace group/setgid binding passed; outside access, named/default ACL drift rejected; existing private child unchanged");
  assert.equal(result.admission, "paused");
  assert.equal(result.publicIngress, "unproven");
  assert.equal((await readCleanInstallJournal(journalPath)).commit, commit);
  assert.equal((await inspectCleanSystemdBoundary({ journalPath, trustDir })).localSystemd, "inactive-bound");
  assert.equal((await verifyAdmissionPause()).paused, true);
  assert.equal((await lstat(path.join(releaseRoot, "current"))).isSymbolicLink(), true);
  await assert.rejects(installCleanPrivateRuntime(controller), /fresh journal/);
  assert.equal((await readCleanInstallJournal(journalPath)).phase, installedPhase);
  if (controller.initializeOwner) {
    if (!useEntry) assert.equal(result.authMode, "oauth");
    assert.equal(result.owner, "candidate-bound");
    await assert.rejects(lstat(`${journalPath}.owner-install.lock`), { code: "ENOENT" });
    assert.equal((await inspectInitializedCleanOwner({ journal: await readCleanInstallJournal(journalPath), trustDir })).owner, "candidate-bound");
    t.diagnostic("One fresh controller composed all real signed private phases and committed OAuth owner readiness; no active service or grant");
    if (useEntry) {
      const requestPath = path.join(workspaceParent, "private-request.json"), policyPath = path.join(workspaceParent, "route-policy.json");
      const record = await readCleanInstallJournal(journalPath);
      const policy = { format: "dp-beget-clean-route-policy-v1", transactionId: record.transactionId,
        artifactSha256: record.artifactSha256, manifestSha256: record.manifestSha256, commit: record.commit,
        domain, expectedIp, unitName: "dp-clean-caddy.service", unitFile: "/etc/systemd/system/dp-clean-caddy.service",
        unitFileSha256: "a".repeat(64), ownerUser: joinedCaddy?.ownerUser || "nobody",
        ownerUid: joinedCaddy?.ownerUid || 65534,
        executable: "/usr/bin/caddy", executableSha256: "b".repeat(64), adminSocket: "/run/dp-caddy/admin.sock" };
      await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600, flag: "wx" });
      const route = { pid: 9001, ownerUid: policy.ownerUid, unitName: policy.unitName, domain, expectedIp,
        caddySystemd: "main-process-bound", caddyProcess: "socket-listener-bound", hostIngress: "dedicated-profile",
        localAddress: "host-bound", localRoute: "local-loopback", policyRules: "default-ipv4",
        caddyConfig: "closed-profile", publicResponse: "closed-upstream", publicIngress: "unproven" };
      // Only the proxy observation/PID is simulated here. The original root
      // request/policy/journal, signed candidate/auth profile and NSS are real;
      // actual Caddy/TLS/host readers remain in their separate netns fixture.
      const inputs = { requestPath, journalPath, policyPath, trustDir,
        readPid: async () => 9001, inspectRoute: async () => ({ ...route }) };
      assert.equal((await inspectCleanInstallRoute(inputs)).installRoute, "signed-install-bound");
      await chmod(policyPath, 0o644); await assert.rejects(inspectCleanInstallRoute(inputs), /untrusted policy file/);
      await chmod(policyPath, 0o600);
      await assert.rejects(inspectCleanInstallRoute({ ...inputs, inspectRoute: async () => {
        await writeFile(policyPath, JSON.stringify({ ...policy, unitFileSha256: "c".repeat(64) })); return { ...route };
      } }), /changed around inspection/);
      await writeFile(policyPath, JSON.stringify(policy));
      assert.equal((await inspectCleanInstallRoute(inputs)).publicIngress, "unproven");
      // The real operator sees a non-running/unproven proxy. Its default
      // gate must refuse before touching the actual signed install journal.
      await assert.rejects(startCleanProtected({ requestPath, policyPath }), /running proxy PID unavailable/);
      assert.equal((await readCleanInstallJournal(journalPath)).phase, "owner-ready");
      await assert.rejects(lstat(`${journalPath}.lock`), { code: "ENOENT" });
      await assert.rejects(lstat(`${journalPath}.startup-install.lock`), { code: "ENOENT" });
      assert.equal((await inspectCleanSystemdBoundary({ journalPath, trustDir })).localSystemd, "inactive-bound");
      t.diagnostic("Actual protected original request/policy/journal and signed candidate/OAuth/NSS binding passed with simulated proxy observation; policy permission/change rejected; startup not authorized");
      if (joinedCaddy) {
        const proxy = {};
        for (const key of ["unitName", "unitFile", "unitFileSha256", "ownerUser", "ownerUid",
          "executable", "executableSha256", "adminSocket", "certificateFiles"]) proxy[key] = joinedCaddy[key];
        const actualPolicy = { ...policy, ...proxy };
        await writeFile(policyPath, JSON.stringify(actualPolicy));
        const worker = path.resolve("scripts/integration/clean-install-https-client.mjs");
        const workerArgs = ["--net=" + joinedCaddy.namespacePath, "--", process.execPath, worker,
          "--fixture-install-options", JSON.stringify({ requestPath, journalPath, policyPath, trustDir })];
        const runJoined = (ca = joinedCaddy.caCert) => exec("nsenter", workerArgs,
          { timeout: 30000, maxBuffer: 8192, env: { ...process.env, NODE_EXTRA_CA_CERTS: ca } });
        let observed;
        try { observed = await runJoined(); }
        catch (error) {
          const safe = error.stderr?.match(/^Disposable joined installation HTTPS fixture rejected: [A-Za-z0-9 :;.,_/-]{1,180}$/m)?.[0];
          throw new Error(safe || "Disposable joined installation HTTPS fixture rejected: worker unavailable");
        }
        const joined = JSON.parse(observed.stdout);
        assert.equal(joined.commit, record.commit); assert.equal(joined.artifactSha256, record.artifactSha256);
        assert.equal(joined.installRoute, "signed-install-bound"); assert.equal(joined.publicIngress, "unproven");
        assert.equal(joined.proxy, "actual-Caddy-systemd-host"); assert.equal(joined.tls, "real-fixture-ca");
        assert.equal(joined.hostStartupGate, "rejected-isolated-namespace");
        await assert.rejects(runJoined(""), error => error.code === 1);
        await writeFile(policyPath, JSON.stringify({ ...actualPolicy, executableSha256: "0".repeat(64) }));
        await assert.rejects(runJoined(), error => error.code === 1);
        await writeFile(policyPath, JSON.stringify(actualPolicy));
        assert.deepEqual(JSON.parse((await runJoined()).stdout), joined);
        t.diagnostic(JSON.stringify(joined));
        t.diagnostic("Joined actual signed private install and actual Caddy/systemd/host/TLS route correlation passed; untrusted CA and wrong executable rejected; DNS simulated; no startup/public acceptance");
      }
    }
  }
  if (process.env.DP_TEST_REAL_CLEAN_OAUTH_STAGING === "1") {
    const agent = await readFile("/etc/dp-beget-bridge/agent.env", "utf8");
    const mcp = await readFile("/etc/dp-beget-bridge/mcp.env", "utf8");
    const repairToken = agent.match(/^DP_AGENT_TOKEN=([0-9a-f]{64})$/m)?.[1];
    const oauthToken = agent.match(/^DP_AGENT_OAUTH_TOKEN=([0-9a-f]{64})$/m)?.[1];
    assert.ok(repairToken && oauthToken && repairToken !== oauthToken);
    assert.ok(!mcp.includes(repairToken));
    assert.ok(mcp.includes(`DP_AGENT_TOKEN=${oauthToken}\n`));
    assert.match(mcp, /DP_MCP_AUTH_MODE=oauth\n/);
    assert.match(mcp, /DP_OWNER_ID=owner-ci\n/);
    assert.doesNotMatch(mcp, /DP_MCP_ACCESS_TOKEN=/);
    for (const [user, file] of [[workUser, "agent.env"], [workUser, "mcp.env"],
      [agentUser, "mcp.env"], [mcpUser, "agent.env"]]) {
      await assert.rejects(exec("runuser", ["-u", user, "--", "test", "-r", `/etc/dp-beget-bridge/${file}`]), error => error.code === 1);
    }
    for (const [user, file] of [[agentUser, "agent.env"], [mcpUser, "mcp.env"]]) {
      await exec("runuser", ["-u", user, "--", "test", "-r", `/etc/dp-beget-bridge/${file}`]);
    }
    t.diagnostic("Real signed private OAuth configuration installed with isolated service-readable groups and no static/repair credential in MCP; owner bootstrap, OAuth app startup and pairing remain separate");
    if (process.env.DP_TEST_REAL_CLEAN_OAUTH_OWNER !== "1") {
      assert.notEqual(process.env.DP_TEST_REAL_CLEAN_STARTUP, "1", "OAuth startup requires separate owner provisioning");
    }
  }
  t.diagnostic("Real signed artifact, dependencies, identities, config, data, promotion, pointer, systemd and admission installation passed; public DNS/TLS simulated; no service startup");
  const authProfile = await inspectCleanInstallAuthProfile(controller);
  assert.equal(Object.keys(authProfile).some(key => /secret|token/i.test(key)), false);
  if (process.env.DP_TEST_REAL_CLEAN_OAUTH_OWNER === "1" && !controller.initializeOwner) {
    assert.equal(authProfile.authMode, "oauth");
    const journal = await readCleanInstallJournal(journalPath);
    const skippedPath = path.join(workspaceParent, "rejected-owner-skip.json");
    await writeFile(skippedPath, JSON.stringify(journal) + "\n", { flag: "wx", mode: 0o600 });
    await assert.rejects(advanceCleanInstallJournal({ journalPath: skippedPath, trustDir,
      transactionId: journal.transactionId, expectedPhase: "admission-ready", nextPhase: "startup-intent",
      inspectClosedIngress: async () => ({ publicIngress: "closed-exclusive" }) }), /authorization phase/);
    await advanceCleanInstallJournal({ journalPath, trustDir, transactionId: journal.transactionId,
      expectedPhase: "admission-ready", nextPhase: "owner-intent" });
    await assert.rejects(installCleanOwner({ journalPath, trustDir,
      advance: async () => { throw new Error("CI interrupted before owner journal commit"); } }), /interrupted before owner journal commit/);
    assert.equal((await readCleanInstallJournal(journalPath)).phase, "owner-intent");
    assert.equal((await inspectInitializedCleanOwner({ journal: await readCleanInstallJournal(journalPath), trustDir })).owner, "candidate-bound");
    assert.ok((await lstat(`${journalPath}.owner-install.lock`)).isFile());
    await assert.rejects(installCleanOwner({ journalPath, trustDir }));
    const authDatabase = "/var/lib/dp-beget-bridge-mcp/auth/auth.sqlite";
    await chmod(authDatabase, 0o644);
    await assert.rejects(recoverCompletedCleanOwner({ journalPath, trustDir }), /Untrusted/);
    assert.ok((await lstat(`${journalPath}.owner-install.lock`)).isFile());
    await chmod(authDatabase, 0o600);
    const updateOwner = async owner => exec("runuser", ["-u", mcpUser, "--", process.execPath,
      "--input-type=module", "--eval",
      "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.env.DP_CI_OWNER_DB);try{db.prepare('UPDATE owners SET id=?').run(process.env.DP_CI_OWNER_ID);}finally{db.close();}"],
    { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", DP_CI_OWNER_DB: authDatabase, DP_CI_OWNER_ID: owner }, timeout: 10000, maxBuffer: 4096 });
    await updateOwner("owner-foreign");
    await assert.rejects(recoverCompletedCleanOwner({ journalPath, trustDir }), /initialized owner is unproven/);
    assert.ok((await lstat(`${journalPath}.owner-install.lock`)).isFile());
    await updateOwner(authProfile.ownerId);
    assert.equal((await recoverCompletedCleanOwner({ journalPath, trustDir })).phase, "owner-ready");
    await assert.rejects(lstat(`${journalPath}.owner-install.lock`), { code: "ENOENT" });
    await assert.rejects(installCleanOwner({ journalPath, trustDir }), /journaled intent/);
    assert.equal((await verifyAdmissionPause()).paused, true);
    t.diagnostic("Real owner bootstrap completed under MCP identity; interrupted commit recovered only after exact candidate-bound owner proof; altered ownership/profile refused; no OAuth client/grant created");
  }
  if (process.env.DP_TEST_REAL_CLEAN_STARTUP !== "1") return;
  // The production route verifier still rejects every public startup. This
  // explicitly enabled disposable local rehearsal injects only that gate;
  // all installed sources, accounts, manager, ports and app health are real.
  assert.throws(requireCleanClosedIngress, /verified closed public route/);
  const inspectClosedIngress = async () => ({ publicIngress: "closed-exclusive" });
  const common = { journalPath, trustDir, inspectClosedIngress };
  const journal = await readCleanInstallJournal(journalPath);
  await advanceCleanInstallJournal({ ...common, transactionId: journal.transactionId,
    expectedPhase: authProfile.authMode === "oauth" ? "owner-ready" : "admission-ready", nextPhase: "startup-intent" });
  const startupData = async (options = {}) => inspectCleanStartupData({ ...options, plan: journal.identityPlan,
    authMode: authProfile.authMode, ownerReady: authProfile.authMode === "oauth",
    identities: await inspectCreatedCleanIdentities({ plan: journal.identityPlan,
      transactionId: journal.transactionId }) });
  await assert.rejects(startCleanLocalServices({ ...common,
    startUnit: async unit => {
      if (unit === core[1]) throw new Error("CI deliberate second-service start failure");
      await systemctl("start", unit);
      await waitForAdmissionDrain({ probes: localReleaseHealthProbes().slice(-1) });
    } }), /CI deliberate second-service start failure/);
  assert.equal((await readCleanInstallJournal(journalPath)).phase, "startup-intent");
  assert.equal((await inspectCleanSystemdBoundary({ journalPath, trustDir })).localSystemd, "inactive-bound");
  assert.equal((await verifyAdmissionPause()).paused, true);
  assert.ok((await lstat(`${journalPath}.startup-install.lock`)).isFile());
  assert.equal((await startupData()).data, "private-owned");
  await assert.rejects(startupData({ requireInitialized: true }), /incomplete/);
  await assert.rejects(inspectInstalledCleanData({ plan: journal.identityPlan,
    identities: await inspectCreatedCleanIdentities({ plan: journal.identityPlan,
      transactionId: journal.transactionId }) }), /untrusted/);
  const stateFile = "/var/lib/dp-beget-bridge/state.sqlite";
  const mode = (await lstat(stateFile)).mode & 0o777;
  await chmod(stateFile, 0o666);
  await assert.rejects(startupData(), /untrusted/);
  await chmod(stateFile, mode);
  const alien = "/var/lib/dp-beget-bridge/unexpected";
  await writeFile(alien, "unexpected", { flag: "wx" });
  await assert.rejects(startupData(), /Unexpected/);
  await rm(alien);
  const alias = "/var/lib/dp-beget-bridge-agent/installation-id";
  await symlink(stateFile, alias);
  await assert.rejects(startupData(), /untrusted/);
  await rm(alias);
  assert.equal((await recoverCleanLocalStartup(common)).localSystemd, "inactive-bound");
  await assert.rejects(lstat(`${journalPath}.startup-install.lock`), { code: "ENOENT" });
  assert.equal((await startCleanLocalServices(common)).phase, "startup-ready");
  assert.equal((await waitForAdmissionDrain({ probes: localReleaseHealthProbes() })).drained, true);
  assert.equal((await readCleanInstallJournal(journalPath)).phase, "startup-ready");
  assert.equal((await startupData({ requireInitialized: true })).data, "private-owned");
  await writeFile(`${journalPath}.startup-install.lock`, `${journal.transactionId}\n`, { mode: 0o600, flag: "wx" });
  assert.equal((await recoverCleanLocalStartup(common)).localSystemd, "active-bound");
  await assert.rejects(lstat(`${journalPath}.startup-install.lock`), { code: "ENOENT" });
  for (const port of [8787, 8788]) {
    const response = await fetch(`http://127.0.0.1:${port}/${port === 8788 ? "mcp" : "sessions"}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 503);
  }
  t.diagnostic("Actual signed Session Host, Agent and MCP started with paused health; second-start interruption stopped attempted units; initialized private data survived deliberate recovery and explicit retry; public route gate remains simulated");
  if (process.env.DP_TEST_REAL_PRIVATE_AUTONOMY === "1") {
    const autonomy = await rehearseCleanPrivateAutonomy({ journalPath, trustDir });
    assert.equal(autonomy.externalEgress, "denied");
    assert.equal(autonomy.terminal, "pass");
    assert.equal(autonomy.fileDownload, "pass");
    assert.equal(autonomy.agentUploadTerminalRoundtrip, "pass");
    assert.equal(autonomy.revocation, "pass");
    assert.equal((await verifyAdmissionPause()).paused, true);
    t.diagnostic(JSON.stringify(autonomy));
    t.diagnostic("AUTO-01..04 supporting fixture: actual signed Direct OAuth DCR/consent, terminal, file download and revocation worked with effective app egress denial; telemetry off; local transport and synthetic owner only");
  }
});

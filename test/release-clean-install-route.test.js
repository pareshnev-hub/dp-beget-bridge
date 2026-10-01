import assert from "node:assert/strict";
import test from "node:test";
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectCleanInstallRoute, parseCleanInstallRoutePolicy, readCleanInstallRoutePolicy } from
  "../scripts/release/inspect-clean-install-route.mjs";

function fixture() {
  const plan = { domain: "bridge.example.com", releaseRoot: "/var/lib/dp-release", allowedRoot: "/srv/work",
    workUser: "worker", workGroup: "worker", agentUser: "dp-agent", mcpUser: "dp-mcp", ipcGroup: "dp-ipc" };
  const journal = { transactionId: "00000000-0000-4000-8000-000000000001", phase: "owner-ready",
    workspace: "/root/private/candidate", releaseRoot: plan.releaseRoot, identityPlan: plan,
    manifestSha256: "a".repeat(64), artifactSha256: "b".repeat(64), commit: "c".repeat(40), version: "0.1.0" };
  const request = { format: "dp-beget-clean-private-request-v1", artifact: "/root/artifact.tar.gz",
    manifest: "/root/manifest.json", signature: "/root/manifest.sig", trustDir: "/root/trust",
    ...plan, workspaceParent: "/root/private", workspace: journal.workspace, journalPath: "/root/private/install.json",
    expectedIp: "1.1.1.1", ownerId: "owner-ci", executionProfile: "full-shell" };
  const policy = { format: "dp-beget-clean-route-policy-v1", transactionId: journal.transactionId,
    manifestSha256: journal.manifestSha256, artifactSha256: journal.artifactSha256, commit: journal.commit,
    domain: plan.domain, expectedIp: request.expectedIp, unitName: "dp-caddy.service",
    unitFile: "/etc/systemd/system/dp-caddy.service", unitFileSha256: "d".repeat(64), ownerUser: "caddy", ownerUid: 123,
    executable: "/usr/bin/caddy", executableSha256: "e".repeat(64), adminSocket: "/run/dp-caddy/admin.sock" };
  const report = { pid: 456, ownerUid: policy.ownerUid, unitName: policy.unitName, domain: policy.domain,
    expectedIp: policy.expectedIp, caddySystemd: "main-process-bound", caddyProcess: "socket-listener-bound",
    hostIngress: "dedicated-profile", localAddress: "host-bound", localRoute: "local-loopback", policyRules: "default-ipv4",
    caddyConfig: "closed-profile", publicResponse: "closed-upstream", publicIngress: "unproven" };
  const state = { request, journal, policy, report, verified: 0, probed: 0 };
  const clone = value => structuredClone(value);
  const args = { requestPath: "/root/private/request.json", journalPath: request.journalPath,
    policyPath: "/root/private/route.json", trustDir: request.trustDir, isRoot: () => true,
    readRequest: async () => clone(state.request), readJournal: async () => clone(state.journal),
    readPolicy: async () => ({ policy: clone(state.policy), identity: [1,2,3,4,5], sha256: "f".repeat(64) }),
    verify: async () => { state.verified++; return { artifactSha256: journal.artifactSha256, commit: journal.commit, version: journal.version }; },
    inspectPlan: async () => clone(plan), readPid: async () => 456,
    inspectAuthProfile: async () => ({ authMode: "oauth", ownerId: "owner-ci", executionProfile: "full-shell" }),
    inspectCreated: async () => ({ identities: "journal-bound", agentUid: 21, mcpUid: 22 }), readUid: async () => 20,
    inspectRoute: async options => { state.probed++; state.options = options; return clone(state.report); } };
  return { state, args };
}

test("OPS-01: private proxy policy cannot add CA overrides, credentials, callbacks or stale PIDs", () => {
  const { state } = fixture(), bytes = object => Buffer.from(JSON.stringify(object));
  assert.deepEqual(parseCleanInstallRoutePolicy(bytes(state.policy)), state.policy);
  for (const change of [{ ca: "/tmp/ca" }, { rejectUnauthorized: false }, { pid: 456 }, { token: "secret" },
    { executableSha256: "invalid" }, { unitFile: "/etc/systemd/system/other.service" }, { ownerUid: 0 },
    { domain: "BRIDGE.example.com" }, { expectedIp: "127.0.0.1" }, { adminSocket: "/run/../admin.sock" },
    { certificateFiles: { certificate: "/x", key: "/x" } }]) {
    assert.throws(() => parseCleanInstallRoutePolicy(bytes({ ...state.policy, ...change })));
  }
  for (const input of [Buffer.alloc(0), Buffer.alloc(16385), Buffer.from("{"), Buffer.from("null"), Buffer.from("[]")]) {
    assert.throws(() => parseCleanInstallRoutePolicy(input));
  }
});

test("OPS-01: signed installation and original protected request bind the complete proxy observation without authorizing startup", async () => {
  const { state, args } = fixture(), report = await inspectCleanInstallRoute(args);
  assert.equal(report.installRoute, "signed-install-bound"); assert.equal(report.publicIngress, "unproven");
  assert.equal(report.commit, state.journal.commit); assert.equal(state.verified, 2); assert.equal(state.probed, 1);
  assert.equal(state.options.pid, 456); assert.equal(state.options.expectedIp, state.request.expectedIp);
  assert.equal(JSON.stringify(report).includes("owner-ci"), false);
});

test("OPS-01: foreign domain/address/artifact/transaction/service plan stops before inspecting a proxy", async () => {
  for (const change of [{ domain: "other.example.com" }, { expectedIp: "8.8.8.8" }, { artifactSha256: "9".repeat(64) },
    { transactionId: "00000000-0000-4000-8000-000000000002" }, { commit: "8".repeat(40) }, { ownerUid: 20 }, { ownerUid: 21 },
    { ownerUid: 22 }, { ownerUser: "worker" }]) {
    const { state, args } = fixture(); Object.assign(state.policy, change);
    await assert.rejects(inspectCleanInstallRoute(args)); assert.equal(state.probed, 0);
  }
  for (const change of [{ workspace: "/root/private/other" }, { agentUser: "other-agent" }, { trustDir: "/root/other-trust" },
    { ownerId: "other-owner" }, { executionProfile: "files-read" }]) {
    const { state, args } = fixture(); Object.assign(state.request, change);
    await assert.rejects(inspectCleanInstallRoute(args)); assert.equal(state.probed, 0);
  }
  const { state, args } = fixture(); state.journal.phase = "owner-intent";
  await assert.rejects(inspectCleanInstallRoute(args)); assert.equal(state.probed, 0);
});

test("OPS-01: partial proxy proof and changes to protected policy/journal/request/PID/signed bytes reject the observation", async () => {
  for (const field of ["pid", "ownerUid", "unitName", "domain", "expectedIp", "caddySystemd", "caddyProcess",
    "hostIngress", "localAddress", "localRoute", "policyRules", "caddyConfig", "publicResponse", "publicIngress"]) {
    const { state, args } = fixture(); delete state.report[field]; await assert.rejects(inspectCleanInstallRoute(args));
  }
  for (const drift of ["policy", "journal", "request", "pid", "signed", "identities", "work-uid", "owner-profile"]) {
    const { state, args } = fixture();
    const route = args.inspectRoute;
    args.inspectRoute = async options => {
      const report = await route(options); state.altered = true;
      if (drift === "policy") state.policy.unitFileSha256 = "1".repeat(64);
      if (drift === "journal") state.journal.phase = "startup-intent";
      if (drift === "request") state.request.expectedIp = "8.8.8.8";
      return report;
    };
    if (drift === "pid") { let reads = 0; args.readPid = async () => ++reads === 1 ? 456 : 457; }
    if (drift === "signed") { let reads = 0; args.verify = async () => ++reads === 1
      ? { artifactSha256: state.journal.artifactSha256, commit: state.journal.commit, version: state.journal.version }
      : { artifactSha256: "9".repeat(64) }; }
    if (drift === "identities") args.inspectCreated = async () => ({ identities: "journal-bound", agentUid: state.altered ? 23 : 21, mcpUid: 22 });
    if (drift === "work-uid") args.readUid = async () => state.altered ? 23 : 20;
    if (drift === "owner-profile") args.inspectAuthProfile = async () => ({ authMode: "oauth",
      ownerId: state.altered ? "foreign-owner" : "owner-ci", executionProfile: "full-shell" });
    await assert.rejects(inspectCleanInstallRoute(args));
  }
});

test("OPS-01: real root policy reader rejects symlinks, hardlinks, permissive metadata and oversized files", async t => {
  if (process.platform !== "linux" || process.getuid?.() !== 0) { t.skip("requires root Linux metadata checks"); return; }
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-clean-route-policy-"));
  t.after(() => rm(root, { recursive: true, force: true })); await chmod(root, 0o700);
  const target = path.join(root, "policy.json"), { state } = fixture();
  await writeFile(target, JSON.stringify(state.policy), { mode: 0o600 });
  assert.deepEqual((await readCleanInstallRoutePolicy(target)).policy, state.policy);
  await symlink(target, path.join(root, "linked.json")); await assert.rejects(readCleanInstallRoutePolicy(path.join(root, "linked.json")));
  await link(target, path.join(root, "hard.json")); await assert.rejects(readCleanInstallRoutePolicy(target));
  await rm(path.join(root, "hard.json")); await chmod(target, 0o644); await assert.rejects(readCleanInstallRoutePolicy(target));
  await chmod(target, 0o600); await writeFile(target, Buffer.alloc(16385)); await assert.rejects(readCleanInstallRoutePolicy(target));
  await chmod(root, 0o755); await assert.rejects(readCleanInstallRoutePolicy(target));
  await mkdir(path.join(root, "directory")); await assert.rejects(readCleanInstallRoutePolicy(path.join(root, "directory")));
});

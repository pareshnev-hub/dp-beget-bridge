import test from "node:test";
import assert from "node:assert/strict";
import { inspectCleanInstallTargets, inspectDirectListeners,
  preflightCleanInstall } from "../scripts/release/preflight-clean-install.mjs";
import { inspectCleanLoopbackListeners } from
  "../scripts/release/inspect-clean-systemd-boundary.mjs";

const valid = { artifact: "/private/archive.tar.gz", manifest: "/private/manifest.json",
  signature: "/private/manifest.sig", domain: "bridge.example.com", expectedIp: "1.1.1.1",
  workUser: "operator", workGroup: "operator", agentUser: "dp-agent",
  mcpUser: "dp-mcp", ipcGroup: "dp-ipc", allowedRoot: "/srv/operator", workspaceParent: "/root/staging",
  releaseRoot: "/opt/dp-beget-bridge-releases", trustDir: "/etc/release-trust",
  isRoot: () => true, loadKey: async () => ({ keyFile: "/etc/release-trust/public.pem",
    fingerprint: "a".repeat(64) }),
  verify: async () => ({ version: "1.0.0", commit: "b".repeat(40), sha256: "c".repeat(64), size: 1024 }),
  inspectHost: async () => ({ domain: "bridge.example.com", expectedIp: "1.1.1.1",
    dns: "pass", tls: "pass" }),
  inspectPorts: async () => ({ directPorts: "unoccupied" }),
  inspectIdentities: async () => ({ reservedIdentities: "unoccupied" }),
};

test("OPS-01: occupied IPv4 or IPv6 Direct ports block clean installation", () => {
  assert.deepEqual(inspectDirectListeners("LISTEN 0 4096 127.0.0.1:1234 0.0.0.0:*\n"),
    { directPorts: "unoccupied" });
  for (const address of ["127.0.0.1:8787", "0.0.0.0:8788", "[::]:8787", "*:8788"]) {
    assert.throws(() => inspectDirectListeners(`LISTEN 0 4096 ${address} *:*\n`), /already occupied/);
  }
  assert.throws(() => inspectDirectListeners("unexpected output\n"), /inventory is invalid/);
});

test("OPS-01: running clean services bind both Direct ports only on IPv4 loopback", () => {
  const line = address => `LISTEN 0 4096 ${address} 0.0.0.0:*\n`;
  const validListeners = line("127.0.0.1:8787") + line("127.0.0.1:8788");
  assert.deepEqual(inspectCleanLoopbackListeners(validListeners),
    { directPorts: "loopback-bound" });
  assert.throws(() => inspectCleanLoopbackListeners(line("127.0.0.1:8787")), /incomplete/);
  for (const address of ["0.0.0.0:8787", "[::]:8788", "*:8787", "[::1]:8788"]) {
    assert.throws(() => inspectCleanLoopbackListeners(validListeners + line(address)),
      /non-loopback or duplicate/);
  }
  assert.throws(() => inspectCleanLoopbackListeners(
    line("127.0.0.1:8787") + line("[::1]:8788")), /non-loopback/);
  assert.throws(() => inspectCleanLoopbackListeners(validListeners + line("127.0.0.1:8788")),
    /non-loopback or duplicate/);
  assert.throws(() => inspectCleanLoopbackListeners(validListeners + "invalid\n"), /Invalid/);
});

test("OPS-01/02: read-only clean install refuses existing services, data, and release paths", async () => {
  const seen = [];
  const fixture = { releaseRoot: valid.releaseRoot, workspaceParent: valid.workspaceParent,
    checkParent: async () => {}, ensureMissing: async filename => { seen.push(filename); },
    getUnit: async () => "LoadState=not-found\n" };
  assert.equal((await inspectCleanInstallTargets(fixture)).units, "unoccupied");
  assert.ok(seen.includes("/var/lib/dp-beget-bridge"));
  assert.ok(seen.includes("/run/dp-beget-bridge"));
  assert.ok(seen.includes("/etc/systemd/system/dp-beget-agent.service"));
  assert.ok(seen.includes("/etc/systemd/system/dp-beget-agent.service.d"));
  await assert.rejects(inspectCleanInstallTargets({ ...fixture,
    getUnit: async unit => unit === "dp-beget-agent.service" ? "LoadState=loaded\n" : "LoadState=not-found\n" }),
  /dp-beget-agent.service/);
  await assert.rejects(inspectCleanInstallTargets({ ...fixture,
    ensureMissing: async filename => { if (filename === "/opt/dp-beget-bridge") throw new Error("existing legacy code"); } }),
  /existing legacy code/);
  await assert.rejects(inspectCleanInstallTargets({ ...fixture,
    ensureMissing: async filename => { if (filename.endsWith("dp-beget-agent.service.d")) {
      throw new Error("unloaded unit drop-in");
    } } }), /unloaded unit drop-in/);
  await assert.rejects(inspectCleanInstallTargets({ ...fixture, releaseRoot: "/root/staging/release" }),
  /must be separate/);
});

test("OPS-01/04: signed candidate and clean endpoints are checked twice without installation", async () => {
  let targetChecks = 0;
  let identityChecks = 0;
  const result = await preflightCleanInstall({ ...valid,
    inspectTargets: async () => { targetChecks++; },
    inspectIdentities: async () => { identityChecks++; },
    inspectSpace: async () => ({ availableBytes: 999n, requiredBytes: 500n }) });
  assert.equal(result.candidate.commit, "b".repeat(40));
  assert.equal(targetChecks, 2);
  assert.equal(identityChecks, 2);
  assert.match(result.scope, /read-only/);
  assert.deepEqual(result.capacity, { availableBytes: "999", requiredBytes: "500" });
  await assert.rejects(preflightCleanInstall({ ...valid,
    inspectTargets: async () => { throw new Error("occupied install target"); },
    inspectSpace: async () => assert.fail("no space check before target check") }), /occupied install target/);
  await assert.rejects(preflightCleanInstall({ ...valid, inspectTargets: async () => {},
    inspectPorts: async () => { throw new Error("occupied Direct port"); },
    inspectSpace: async () => assert.fail("no space check before port check") }), /occupied Direct port/);
  let probes = 0;
  await assert.rejects(preflightCleanInstall({ ...valid, inspectTargets: async () => {},
    inspectSpace: async () => ({ availableBytes: 999n, requiredBytes: 500n }), inspectHost: async () => ({
      domain: "bridge.example.com", expectedIp: "1.1.1.1", dns: "pass", tls: ++probes === 1 ? "pass" : "changed" }) }),
  /Install host changed/);
  await assert.rejects(preflightCleanInstall({ ...valid, inspectTargets: async () => {},
    inspectSpace: async () => ({ availableBytes: 1n, requiredBytes: 500n }) }), /capacity is unproven/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { inspectCleanInstallTargets, preflightCleanInstall } from "../scripts/release/preflight-clean-install.mjs";

const valid = { artifact: "/private/archive.tar.gz", manifest: "/private/manifest.json",
  signature: "/private/manifest.sig", domain: "bridge.example.com", expectedIp: "1.1.1.1",
  workUser: "operator", allowedRoot: "/srv/operator", workspaceParent: "/root/staging",
  releaseRoot: "/opt/dp-beget-bridge-releases", trustDir: "/etc/release-trust",
  isRoot: () => true, loadKey: async () => ({ keyFile: "/etc/release-trust/public.pem",
    fingerprint: "a".repeat(64) }),
  verify: async () => ({ version: "1.0.0", commit: "b".repeat(40), sha256: "c".repeat(64), size: 1024 }),
  inspectHost: async () => ({ domain: "bridge.example.com", expectedIp: "1.1.1.1",
    dns: "pass", tls: "pass" }),
};

test("OPS-01/02: read-only clean install refuses existing services, data, and release paths", async () => {
  const seen = [];
  const fixture = { releaseRoot: valid.releaseRoot, workspaceParent: valid.workspaceParent,
    checkParent: async () => {}, ensureMissing: async filename => { seen.push(filename); },
    getUnit: async () => "LoadState=not-found\n" };
  assert.equal((await inspectCleanInstallTargets(fixture)).units, "unoccupied");
  assert.ok(seen.includes("/var/lib/dp-beget-bridge"));
  await assert.rejects(inspectCleanInstallTargets({ ...fixture,
    getUnit: async unit => unit === "dp-beget-agent.service" ? "LoadState=loaded\n" : "LoadState=not-found\n" }),
  /dp-beget-agent.service/);
  await assert.rejects(inspectCleanInstallTargets({ ...fixture,
    ensureMissing: async filename => { if (filename === "/opt/dp-beget-bridge") throw new Error("existing legacy code"); } }),
  /existing legacy code/);
  await assert.rejects(inspectCleanInstallTargets({ ...fixture, releaseRoot: "/root/staging/release" }),
  /must be separate/);
});

test("OPS-01/04: signed candidate and clean endpoints are checked twice without installation", async () => {
  let targetChecks = 0;
  const result = await preflightCleanInstall({ ...valid,
    inspectTargets: async () => { targetChecks++; },
    inspectSpace: async () => ({ availableBytes: 999n, requiredBytes: 500n }) });
  assert.equal(result.candidate.commit, "b".repeat(40));
  assert.equal(targetChecks, 2);
  assert.match(result.scope, /read-only/);
  assert.deepEqual(result.capacity, { availableBytes: "999", requiredBytes: "500" });
  await assert.rejects(preflightCleanInstall({ ...valid,
    inspectTargets: async () => { throw new Error("occupied install target"); },
    inspectSpace: async () => assert.fail("no space check before target check") }), /occupied install target/);
  let probes = 0;
  await assert.rejects(preflightCleanInstall({ ...valid, inspectTargets: async () => {},
    inspectSpace: async () => ({ availableBytes: 999n, requiredBytes: 500n }), inspectHost: async () => ({
      domain: "bridge.example.com", expectedIp: "1.1.1.1", dns: "pass", tls: ++probes === 1 ? "pass" : "changed" }) }),
  /Install host changed/);
  await assert.rejects(preflightCleanInstall({ ...valid, inspectTargets: async () => {},
    inspectSpace: async () => ({ availableBytes: 1n, requiredBytes: 500n }) }), /capacity is unproven/);
});

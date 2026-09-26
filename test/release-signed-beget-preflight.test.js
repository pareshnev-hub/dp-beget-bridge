import assert from "node:assert/strict";
import test from "node:test";
import { preflightSignedBegetMigration } from "../scripts/release/preflight-signed-beget-migration.mjs";

const databases = [
  { unit: "dp-beget-session-host.service", database: "/var/lib/dp-beget-bridge/state.sqlite", size: 100 },
  { unit: "dp-beget-agent.service", database: "/var/lib/dp-beget-bridge-agent/session-owners.sqlite", size: 100 },
  { unit: "dp-beget-mcp-oauth-spike.service", database: "/var/lib/dp-beget-bridge-mcp/auth/auth.sqlite", size: 100 },
];
const candidate = { version: "0.1.0", commit: "a".repeat(40),
  sha256: "b".repeat(64), size: 8192 };
const args = { artifact: "/candidate/archive.tar.gz", manifest: "/candidate/manifest.json",
  signature: "/candidate/manifest.sig", domain: "bridge-oauth.pareshnev.com",
  expectedIp: "45.12.238.143", workUser: "dp-preview", allowedRoot: "/srv/work",
  workspaceParent: "/private/releases", snapshotParent: "/private/snapshots" };

function fixture(log, more = {}) {
  return { ...args,
    isRoot: () => true,
    loadKey: async () => { log.push("key"); return { keyFile: "/trusted/public.pem",
      fingerprint: "c".repeat(64) }; },
    verify: async options => { log.push("signature");
      assert.equal(options.trustedKey, "/trusted/public.pem"); return candidate; },
    inspectHost: async options => { log.push("host");
      return { domain: options.domain, expectedIp: options.expectedIp, dns: "pass", tls: "pass" }; },
    inspectLegacy: async () => { log.push("legacy");
      return { boundary: { route: "pinned" }, bindings: { databases } }; },
    inspectSpace: async options => { log.push("capacity");
      assert.equal(options.archiveBytes, candidate.size);
      assert.deepEqual(options.databases.map(item => item.name), ["session-host", "agent", "oauth"]);
      return { availableBytes: 9000, requiredBytes: 8000 }; },
    proveExclusive: async () => { log.push("exclusive"); return true; },
    ...more,
  };
}

test("R0004: one read-only signed-candidate check brackets live route and capacity", async () => {
  const log = [];
  const result = await preflightSignedBegetMigration(fixture(log));
  assert.deepEqual(log, ["key", "signature", "host", "legacy", "capacity", "exclusive", "legacy"]);
  assert.equal(result.candidate.commit, candidate.commit);
  assert.equal(result.candidate.keyFingerprint, "c".repeat(64));
  assert.equal(result.databases, 3);
  assert.match(result.scope, /no drain/);
  assert.doesNotMatch(JSON.stringify(result), /\/private\/|\/var\/lib\//);
});

test("R0004: invalid signature or changed live bindings stops the combined gate", async () => {
  const log = [];
  await assert.rejects(preflightSignedBegetMigration(fixture(log, {
    verify: async () => { throw new Error("invalid signature"); },
  })), /invalid signature/);
  assert.deepEqual(log, ["key"]);

  let reads = 0;
  await assert.rejects(preflightSignedBegetMigration(fixture([], {
    inspectLegacy: async () => ({ boundary: { route: "pinned" },
      bindings: { databases: ++reads === 1 ? databases : [...databases.slice(0, 2),
        { ...databases[2], size: 101 }] } }),
  })), /changed during candidate preflight/);
  await assert.rejects(preflightSignedBegetMigration(fixture([], {
    proveExclusive: async () => false,
  })), /Exclusive OAuth route is unproven/);
});

test("R0004: combined check refuses an unpinned host before reading a candidate", async () => {
  const log = [];
  await assert.rejects(preflightSignedBegetMigration({ ...fixture(log), domain: "other.example.com" }),
    /exact Beget candidate/);
  await assert.rejects(preflightSignedBegetMigration({ ...fixture(log), isRoot: () => false }),
    /Root/);
  assert.deepEqual(log, []);
});

#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertBegetOAuthRouteExclusive } from "./assert-beget-oauth-route-exclusive.mjs";
import { preflightHost } from "./host-preflight.mjs";
import { inspectMigrationSpace } from "./inspect-migration-space.mjs";
import { boundDatabases } from "./legacy-bound-databases.mjs";
import { DEFAULT_TRUST_DIR, loadPinnedReleaseKey } from "./pin-release-key.mjs";
import { preflightBegetLegacyRoute } from "./preflight-beget-legacy-route.mjs";
import { verifyArtifact } from "./verify-artifact.mjs";

// One read-only gate over the actual signed candidate and the pinned R0003
// environment. A passing observation cannot authorize stopping admissions,
// switching code, restoring state, or reopening a public route.
export async function preflightSignedBegetMigration({ artifact, manifest, signature,
  domain, expectedIp, workUser, allowedRoot, workspaceParent, snapshotParent,
  trustDir = DEFAULT_TRUST_DIR,
  isRoot = () => process.getuid?.() === 0,
  loadKey = loadPinnedReleaseKey, verify = verifyArtifact,
  inspectHost = preflightHost, inspectLegacy = preflightBegetLegacyRoute,
  inspectSpace = inspectMigrationSpace,
  proveExclusive = assertBegetOAuthRouteExclusive } = {}) {
  if (!isRoot() || domain !== "bridge-oauth.pareshnev.com" ||
      expectedIp !== "45.12.238.143" ||
      [artifact, manifest, signature, allowedRoot, workspaceParent, snapshotParent, trustDir]
        .some(value => typeof value !== "string" || !path.isAbsolute(value) ||
          path.normalize(value) !== value) ||
      typeof workUser !== "string" || !workUser) {
    throw new Error("Root and the exact Beget candidate and host inputs are required");
  }
  const { keyFile, fingerprint } = await loadKey({ trustDir });
  const candidate = await verify({ artifact, manifest, signature, trustedKey: keyFile });
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?$/.test(candidate?.version || "") ||
      !/^[0-9a-f]{40}$/.test(candidate?.commit || "") ||
      !/^[0-9a-f]{64}$/.test(candidate?.sha256 || "") ||
      !Number.isSafeInteger(candidate?.size) || candidate.size < 1 ||
      !/^[0-9a-f]{64}$/.test(fingerprint || "")) {
    throw new Error("Signed release identity is incomplete");
  }
  const host = await inspectHost({ domain, expectedIp, workUser, allowedRoot });
  if (host?.domain !== domain || host?.expectedIp !== expectedIp ||
      host?.dns !== "pass" || host?.tls !== "pass") {
    throw new Error("Beget host proof did not match the signed release target");
  }
  const before = await inspectLegacy();
  const databases = boundDatabases(before);
  const capacity = await inspectSpace({ workspaceParent, snapshotParent,
    archiveBytes: candidate.size, databases });
  if (!Number.isSafeInteger(capacity?.availableBytes) ||
      !Number.isSafeInteger(capacity?.requiredBytes) ||
      capacity.availableBytes < capacity.requiredBytes) {
    throw new Error("Combined release and state capacity is unproven");
  }
  if (await proveExclusive() !== true) throw new Error("Exclusive OAuth route is unproven");
  const after = await inspectLegacy();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("Beget route or data bindings changed during candidate preflight");
  }
  return {
    candidate: { version: candidate.version, commit: candidate.commit,
      sha256: candidate.sha256, keyFingerprint: fingerprint },
    host: { domain, expectedIp },
    route: "exclusive at the time of inspection",
    databases: databases.length,
    capacity: { availableBytes: capacity.availableBytes,
      requiredBytes: capacity.requiredBytes },
    scope: "read-only signed candidate and current R0003 host; no drain, snapshot, install, recovery or ongoing route guarantee",
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = ["artifact", "manifest", "signature", "domain", "expected-ip",
    "work-user", "allowed-root", "workspace-parent", "snapshot-parent"];
  const args = process.argv.slice(2);
  const options = {};
  let valid = args.length === names.length * 2;
  for (let i = 0; valid && i < args.length; i += 2) {
    valid = args[i] === `--${names[i / 2]}` && args[i + 1]?.length > 0;
    if (valid) options[names[i / 2].replaceAll("-", "_")] = args[i + 1];
  }
  if (!valid) {
    console.error(`Usage: preflight-signed-beget-migration ${names.map(name =>
      `--${name} VALUE`).join(" ")}`);
    process.exitCode = 64;
  } else {
    preflightSignedBegetMigration({ artifact: options.artifact, manifest: options.manifest,
      signature: options.signature, domain: options.domain, expectedIp: options.expected_ip,
      workUser: options.work_user, allowedRoot: options.allowed_root,
      workspaceParent: options.workspace_parent,
      snapshotParent: options.snapshot_parent }).then(result => {
      console.log(JSON.stringify(result));
    }).catch(() => {
      console.error("Signed Beget migration preflight failed (validation); no services changed");
      process.exitCode = 1;
    });
  }
}

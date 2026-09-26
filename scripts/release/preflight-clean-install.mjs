#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { preflightHost } from "./host-preflight.mjs";
import { inspectReleasePreparationSpace } from "./inspect-release-preparation-space.mjs";
import { DEFAULT_TRUST_DIR, loadPinnedReleaseKey } from "./pin-release-key.mjs";
import { verifyArtifact } from "./verify-artifact.mjs";

const exec = promisify(execFile);
const UNITS = ["dp-beget-session-host.service", "dp-beget-agent.service", "dp-beget-mcp.service",
  "dp-beget-mcp-oauth-spike.service", "dp-beget-tunnel.service", "dp-beget-oauth-proxy.socket",
  "dp-beget-oauth-proxy.service"];
const LEGACY_PATHS = ["/opt/dp-beget-bridge", "/etc/dp-beget-bridge/bridge.env",
  "/etc/dp-beget-bridge/agent.env", "/etc/dp-beget-bridge/mcp.env",
  "/etc/dp-beget-bridge/mcp-oauth-spike.env", "/etc/dp-beget-bridge/session-host.env",
  "/var/lib/dp-beget-bridge", "/var/lib/dp-beget-bridge-agent", "/var/lib/dp-beget-bridge-mcp"];

async function showUnit(unit) {
  const { stdout } = await exec("systemctl", ["show", unit, "--property=LoadState", "--no-pager"],
    { timeout: 5000, maxBuffer: 4096 });
  return stdout;
}

async function assertMissing(filename) {
  try { await lstat(filename); throw new Error("Install target is already present"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

async function assertRootOwnedParent(filename) {
  if (typeof filename !== "string" || !path.isAbsolute(filename) ||
      path.normalize(filename) !== filename) throw new Error("An absolute normalized install path is required");
  const parent = path.dirname(filename);
  const info = await stat(parent);
  if ((await realpath(parent)) !== parent || !info.isDirectory() || info.uid !== 0 ||
      (info.mode & 0o022) !== 0) throw new Error("Install parent is not a safe root-owned directory");
}

export async function inspectCleanInstallTargets({ releaseRoot, workspaceParent,
  getUnit = showUnit, ensureMissing = assertMissing, checkParent = assertRootOwnedParent } = {}) {
  if (typeof releaseRoot !== "string" || typeof workspaceParent !== "string" ||
      !path.isAbsolute(releaseRoot) || !path.isAbsolute(workspaceParent) ||
      path.normalize(releaseRoot) !== releaseRoot ||
      path.normalize(workspaceParent) !== workspaceParent) {
    throw new Error("Absolute normalized install paths are required");
  }
  if (releaseRoot === workspaceParent || releaseRoot.startsWith(`${workspaceParent}${path.sep}`) ||
      workspaceParent.startsWith(`${releaseRoot}${path.sep}`)) {
    throw new Error("Install release and workspace paths must be separate");
  }
  await checkParent(releaseRoot);
  await checkParent(path.join(workspaceParent, "candidate-workspace"));
  await ensureMissing(releaseRoot);
  for (const unit of UNITS) {
    if (await getUnit(unit) !== "LoadState=not-found\n") throw new Error(`Install unit already exists: ${unit}`);
  }
  for (const filename of LEGACY_PATHS) await ensureMissing(filename);
  return { units: "unoccupied", legacyPaths: "absent", releaseRoot: "absent" };
}

// Read-only preflight for an already routed, clean Ubuntu host. No proxy
// configuration, identity, data directory, unit, or install workspace is created.
export async function preflightCleanInstall({ artifact, manifest, signature, domain,
  expectedIp, workUser, allowedRoot, workspaceParent, releaseRoot,
  trustDir = DEFAULT_TRUST_DIR, isRoot = () => process.getuid?.() === 0,
  loadKey = loadPinnedReleaseKey, verify = verifyArtifact, inspectHost = preflightHost,
  inspectTargets = inspectCleanInstallTargets, inspectSpace = inspectReleasePreparationSpace } = {}) {
  if (!isRoot() || [artifact, manifest, signature, allowedRoot, workspaceParent, releaseRoot, trustDir]
    .some(value => typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value)) {
    throw new Error("Root and normalized absolute clean-install inputs are required");
  }
  const { keyFile, fingerprint } = await loadKey({ trustDir });
  const candidate = await verify({ artifact, manifest, signature, trustedKey: keyFile });
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?$/.test(candidate?.version || "") ||
      !/^[0-9a-f]{40}$/.test(candidate?.commit || "") ||
      !/^[0-9a-f]{64}$/.test(candidate?.sha256 || "") ||
      !Number.isSafeInteger(candidate?.size) || candidate.size < 1 ||
      !/^[0-9a-f]{64}$/.test(fingerprint || "")) throw new Error("Signed candidate identity is incomplete");
  const host = await inspectHost({ domain, expectedIp, workUser, allowedRoot });
  if (host?.dns !== "pass" || host?.tls !== "pass" || host?.domain !== domain ||
      host?.expectedIp !== expectedIp) throw new Error("Clean-install host prerequisites are unproven");
  await inspectTargets({ releaseRoot, workspaceParent });
  const capacity = await inspectSpace({ parent: workspaceParent, archiveBytes: candidate.size });
  if (typeof capacity?.availableBytes !== "bigint" ||
      typeof capacity?.requiredBytes !== "bigint" ||
      capacity.requiredBytes < 1n || capacity.availableBytes < capacity.requiredBytes) {
    throw new Error("Clean-install candidate capacity is unproven");
  }
  // Recheck all mutable local targets and endpoints around the space inspection.
  await inspectTargets({ releaseRoot, workspaceParent });
  const again = await inspectHost({ domain, expectedIp, workUser, allowedRoot });
  if (JSON.stringify(host) !== JSON.stringify(again)) throw new Error("Install host changed during preflight");
  return { candidate: { version: candidate.version, commit: candidate.commit,
    sha256: candidate.sha256, keyFingerprint: fingerprint }, host: { domain, expectedIp },
    capacity: { availableBytes: capacity.availableBytes.toString(),
      requiredBytes: capacity.requiredBytes.toString() },
    scope: "read-only clean host inventory; reverse-proxy routing, installation, service startup and rollback unproven" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = ["artifact", "manifest", "signature", "domain", "expected-ip", "work-user",
    "allowed-root", "workspace-parent", "release-root"];
  const args = process.argv.slice(2);
  if (args.length !== names.length * 2 || names.some((name, i) =>
    args[2 * i] !== `--${name}` || !args[2 * i + 1])) {
    console.error(`Usage: preflight-clean-install ${names.map(name => `--${name} VALUE`).join(" ")}`);
    process.exitCode = 64;
  } else {
    const inputs = Object.fromEntries(names.map((name, i) => [name.replaceAll("-", "_"), args[2 * i + 1]]));
    preflightCleanInstall({ artifact: inputs.artifact, manifest: inputs.manifest,
      signature: inputs.signature, domain: inputs.domain, expectedIp: inputs.expected_ip,
      workUser: inputs.work_user, allowedRoot: inputs.allowed_root,
      workspaceParent: inputs.workspace_parent, releaseRoot: inputs.release_root }).then(result => {
      console.log(JSON.stringify(result));
    }).catch(() => {
      console.error("Clean-install preflight failed (validation); no services changed");
      process.exitCode = 1;
    });
  }
}

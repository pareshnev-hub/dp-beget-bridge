#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { inspectTar } from "./extract-verified-artifact.mjs";
import { DEFAULT_TRUST_DIR, loadPinnedReleaseKey } from "./pin-release-key.mjs";
import { readRegularFile, verifyArtifact } from "./verify-artifact.mjs";

const UNITS = ["dp-beget-session-host.service", "dp-beget-agent.service", "dp-beget-mcp.service"];
const REPLACEMENTS = {
  "dp-beget-session-host.service": ["WORK_USER", "WORK_GROUP", "IPC_GROUP", "ALLOWED_ROOT"],
  "dp-beget-agent.service": ["AGENT_USER", "AGENT_GROUP", "IPC_GROUP", "ALLOWED_ROOT"],
  "dp-beget-mcp.service": ["MCP_USER", "MCP_GROUP"],
};

function safeName(name) {
  if (typeof name !== "string" || !/^[a-z_][a-z0-9_-]*[$]?$/.test(name) || name === "root") {
    throw new Error("Unsafe service identity");
  }
  return name;
}

function safePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value ||
      !/^\/[a-zA-Z0-9_./-]+$/.test(value) || value.split("/").includes("..")) {
    throw new Error("Unsafe systemd path");
  }
  return value;
}

export function renderCleanInstallUnits({ templates, releaseRoot, allowedRoot, workUser,
  workGroup, agentUser, mcpUser, ipcGroup }) {
  safePath(releaseRoot);
  safePath(allowedRoot);
  const values = { WORK_USER: safeName(workUser), WORK_GROUP: safeName(workGroup),
    AGENT_USER: safeName(agentUser), AGENT_GROUP: safeName(agentUser),
    MCP_USER: safeName(mcpUser), MCP_GROUP: safeName(mcpUser),
    IPC_GROUP: safeName(ipcGroup), ALLOWED_ROOT: allowedRoot };
  if (new Set([workUser, agentUser, mcpUser]).size !== 3 ||
      releaseRoot === allowedRoot || releaseRoot.startsWith(`${allowedRoot}/`) ||
      allowedRoot.startsWith(`${releaseRoot}/`)) {
    throw new Error("Install paths and service users must be separate");
  }
  const output = {};
  for (const unit of UNITS) {
    let source = templates[unit];
    if (typeof source !== "string" || source.length > 16 * 1024 ||
        !source.includes("WorkingDirectory=/opt/dp-beget-bridge\n") ||
        source.split("WorkingDirectory=/opt/dp-beget-bridge\n").length !== 2) {
      throw new Error(`Invalid signed systemd template: ${unit}`);
    }
    const expected = REPLACEMENTS[unit];
    const found = [...source.matchAll(/__DP_([A-Z_]+)__/g)].map(match => match[1]).sort();
    const required = unit === "dp-beget-session-host.service"
      ? ["ALLOWED_ROOT", "IPC_GROUP", "WORK_GROUP", "WORK_USER"]
      : unit === "dp-beget-agent.service"
        ? ["AGENT_GROUP", "AGENT_USER", "ALLOWED_ROOT", "IPC_GROUP"]
        : ["MCP_GROUP", "MCP_USER"];
    if (JSON.stringify(found) !== JSON.stringify(required.sort())) {
      throw new Error(`Unexpected signed systemd placeholders: ${unit}`);
    }
    for (const key of expected) source = source.replaceAll(`__DP_${key}__`, values[key]);
    source = source.replace("WorkingDirectory=/opt/dp-beget-bridge\n",
      `WorkingDirectory=${releaseRoot}/current\n`);
    if (source.includes("__DP_") || !source.endsWith("\n")) throw new Error(`Invalid rendered systemd unit: ${unit}`);
    output[unit] = source;
  }
  return output;
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// Creates only inert, private unit files. A separate installer must verify
// identities, config, public routing and rollback before loading any unit.
export async function stageCleanInstallUnits({ artifact, manifest, signature,
  stageDir, releaseRoot, allowedRoot, workUser, workGroup, agentUser, mcpUser,
  ipcGroup, trustDir = DEFAULT_TRUST_DIR } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to stage units");
  safePath(stageDir);
  const parent = path.dirname(stageDir);
  const parentInfo = await stat(parent);
  if ((await realpath(parent)) !== parent || !parentInfo.isDirectory() || parentInfo.uid !== 0 ||
      (parentInfo.mode & 0o077) !== 0) throw new Error("Unit staging parent must be private and root-owned");
  for (const filename of [artifact, manifest, signature, trustDir]) {
    if (typeof filename !== "string" || !path.isAbsolute(filename) ||
        filename === stageDir || filename.startsWith(`${stageDir}/`)) {
      throw new Error("Signed inputs cannot be in unit staging directory");
    }
  }
  const { keyFile } = await loadPinnedReleaseKey({ trustDir });
  const identity = await verifyArtifact({ artifact, manifest, signature, trustedKey: keyFile });
  if (identity.size > 64 * 1024 * 1024) throw new Error("Signed archive exceeds release ceiling");
  const compressed = await readRegularFile(artifact, 64 * 1024 * 1024);
  if (compressed.length !== identity.size ||
      createHash("sha256").update(compressed).digest("hex") !== identity.sha256) {
    throw new Error("Signed archive changed before unit staging");
  }
  const entries = inspectTar(gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 }),
    identity.version, identity.commit);
  const root = `dp-beget-bridge-${identity.version}/deploy/systemd/`;
  const templates = Object.fromEntries(UNITS.map(unit => {
    const entry = entries.find(item => item.relative === `${root}${unit}` && !item.directory);
    if (!entry) throw new Error(`Signed archive lacks ${unit}`);
    return [unit, entry.content.toString("utf8")];
  }));
  const units = renderCleanInstallUnits({ templates, releaseRoot, allowedRoot,
    workUser, workGroup, agentUser, mcpUser, ipcGroup });
  await mkdir(stageDir, { mode: 0o700 });
  try {
    for (const unit of UNITS) {
      const handle = await open(path.join(stageDir, unit),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(units[unit]); await handle.sync(); }
      finally { await handle.close(); }
    }
    await syncDirectory(stageDir);
    await syncDirectory(parent);
    return { units: [...UNITS], sha256: identity.sha256 };
  } catch (error) {
    await rm(stageDir, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error("Unit staging is an installer API; public CLI is pending a journaled clean-install controller");
  process.exitCode = 64;
}

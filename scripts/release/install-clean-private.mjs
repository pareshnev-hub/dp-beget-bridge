#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { prepareCleanInstall } from "./prepare-clean-install.mjs";
import { installCleanPrivateRuntime } from "./install-clean-private-runtime.mjs";
import { validateHostname, validatePublicIpv4 } from "./host-preflight.mjs";
import { validateCleanInstallAuthSelection } from "./stage-clean-install-config.mjs";

const FORMAT = "dp-beget-clean-private-request-v1";
const PATHS = ["artifact", "manifest", "signature", "trustDir", "allowedRoot",
  "workspaceParent", "workspace", "releaseRoot", "journalPath"];
const KEYS = ["format", ...PATHS, "domain", "expectedIp", "workUser", "workGroup",
  "agentUser", "mcpUser", "ipcGroup", "ownerId", "executionProfile"];

function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).sort().join(",") !== [...KEYS].sort().join(",") || request.format !== FORMAT ||
      PATHS.some(key => typeof request[key] !== "string" || !path.isAbsolute(request[key]) ||
        path.normalize(request[key]) !== request[key] || /[\x00-\x1f\x7f]/.test(request[key])) ||
      ["workUser", "workGroup", "agentUser", "mcpUser", "ipcGroup"].some(key =>
        !/^[a-z_][a-z0-9_-]{0,31}$/.test(request[key] || "") || request[key] === "root") ||
      path.dirname(request.workspace) !== request.workspaceParent ||
      path.basename(request.workspace).startsWith(".") ||
      path.dirname(request.journalPath) !== request.workspaceParent ||
      path.basename(request.journalPath).startsWith(".") ||
      request.workspace === request.journalPath || request.releaseRoot === request.workspaceParent ||
      request.releaseRoot.startsWith(`${request.workspaceParent}/`) ||
      request.workspaceParent.startsWith(`${request.releaseRoot}/`) ||
      new Set([request.artifact, request.manifest, request.signature]).size !== 3) {
    throw new Error("Invalid clean private installation request");
  }
  if (validateHostname(request.domain) !== request.domain) throw new Error("Normalized clean domain required");
  validatePublicIpv4(request.expectedIp);
  validateCleanInstallAuthSelection({ authMode: "oauth", ownerId: request.ownerId,
    executionProfile: request.executionProfile });
  return request;
}

export function parseCleanPrivateRequest(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 16384) {
    throw new Error("Invalid clean private request size");
  }
  let request;
  try { request = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Invalid clean private request JSON"); }
  return validateRequest(request);
}

export async function readCleanPrivateRequest(requestPath) {
  if (process.getuid?.() !== 0 || typeof requestPath !== "string" ||
      !path.isAbsolute(requestPath) || path.normalize(requestPath) !== requestPath) {
    throw new Error("Root and normalized private request path required");
  }
  const parent = path.dirname(requestPath), directory = await lstat(parent);
  if (!directory.isDirectory() || directory.uid !== 0 || (directory.mode & 0o777) !== 0o700 ||
      await realpath(parent) !== parent) throw new Error("Untrusted clean private request parent");
  const handle = await open(requestPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== 0 || before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o600 || before.size < 1 || before.size > 16384 ||
        await realpath(requestPath) !== requestPath) throw new Error("Untrusted clean private request file");
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat(), named = await lstat(requestPath);
    const identity = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
    if (bytesRead !== before.size || !isDeepStrictEqual(identity(before), identity(after)) ||
        !isDeepStrictEqual(identity(before), identity(named))) {
      throw new Error("Clean private request changed during read");
    }
    return parseCleanPrivateRequest(buffer.subarray(0, bytesRead));
  } finally { await handle.close(); }
}

// Deliberately private and fresh only. Does not install dependencies on the
// host, pin a new release key, start services, open routes or resume admission.
export async function installCleanPrivate({ requestPath, readRequest = readCleanPrivateRequest,
  prepare = prepareCleanInstall, install = installCleanPrivateRuntime,
  isRoot = () => process.getuid?.() === 0 } = {}) {
  if (!isRoot()) throw new Error("Root is required for clean private installation");
  const request = validateRequest(await readRequest(requestPath));
  try { await lstat(request.journalPath); throw new Error("Clean private installation requires a fresh journal"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const { format, journalPath, ...inputs } = request;
  const prepared = await prepare({ ...inputs, authMode: "oauth" });
  if (prepared?.workspace !== request.workspace || !/^[0-9a-f]{64}$/.test(prepared.manifestSha256 || "") ||
      !/^[0-9a-f]{64}$/.test(prepared.sha256 || "") || !/^[0-9a-f]{40}$/.test(prepared.commit || "") ||
      !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(prepared.version || "")) {
    throw new Error("Prepared clean private candidate identity is unproven");
  }
  const result = await install({ journalPath, workspace: request.workspace,
    manifestSha256: prepared.manifestSha256, releaseRoot: request.releaseRoot,
    trustDir: request.trustDir, initializeOwner: true });
  if (result?.phase !== "owner-ready" || result.owner !== "candidate-bound" || result.authMode !== "oauth" ||
      result.localServices !== "inactive" || result.admission !== "paused" || result.publicIngress !== "unproven" ||
      result.commit !== prepared.commit || result.version !== prepared.version ||
      !/^[0-9a-f-]{36}$/.test(result.transactionId || "")) {
    throw new Error("Final clean private owner installation is unproven; journal retained");
  }
  // Select bounded non-secret fields explicitly instead of forwarding any
  // preparer/installer output or credential-bearing error causes.
  return { transactionId: result.transactionId, version: prepared.version, commit: prepared.commit,
    phase: "owner-ready", owner: "candidate-bound", localServices: "inactive",
    admission: "paused", publicIngress: "unproven" };
}

export async function runCleanPrivateCli(args, { install = installCleanPrivate,
  stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text) } = {}) {
  if (args.length !== 2 || args[0] !== "--request" || !args[1]) {
    stderr("Usage: install-clean-private --request ABSOLUTE_PRIVATE_JSON_FILE\n"); return 64;
  }
  try {
    const result = await install({ requestPath: args[1] });
    stdout(JSON.stringify(result) + "\n"); return 0;
  } catch {
    stderr("Clean private installation stopped; preserve candidate and any journal/locks for deliberate recovery. No public release acceptance.\n");
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCleanPrivateCli(process.argv.slice(2));
}

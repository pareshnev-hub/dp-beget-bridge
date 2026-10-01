import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { readCleanPrivateRequest, parseCleanPrivateRequest } from "./install-clean-private.mjs";
import { readCleanInstallJournal } from "./clean-install-journal.mjs";
import { verifyCleanInstallManifest } from "./clean-install-manifest.mjs";
import { inspectCleanInstallIdentityPlan } from "./clean-install-identity-plan.mjs";
import { validateCleanCaddyUnitInputs } from "./inspect-clean-caddy-systemd.mjs";
import { inspectCleanCaddyHostRoute } from "./inspect-clean-caddy-host.mjs";
import { validateHostname, validatePublicIpv4 } from "./host-preflight.mjs";
import { inspectCleanInstallAuthProfile } from "./clean-install-auth-profile.mjs";
import { inspectCreatedCleanIdentities } from "./inspect-clean-install-created-identities.mjs";

const exec = promisify(execFile), SHA = /^[0-9a-f]{64}$/;
const BINDINGS = ["transactionId", "manifestSha256", "artifactSha256", "commit", "domain", "expectedIp"];
const PROXY = ["unitName", "unitFile", "unitFileSha256", "ownerUser", "ownerUid", "executable",
  "executableSha256", "adminSocket"];
function check(ok, reason) { if (!ok) throw new Error(`Clean installation route: ${reason}`); }
function absolute(value) {
  return typeof value === "string" && path.isAbsolute(value) && path.normalize(value) === value &&
    /^\/[a-zA-Z0-9_./-]+$/.test(value) && value !== "/";
}

export function parseCleanInstallRoutePolicy(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 16384, "invalid policy size");
  let policy;
  try { policy = JSON.parse(bytes.toString("utf8")); } catch { check(false, "invalid policy JSON"); }
  const fields = ["format", ...BINDINGS, ...PROXY];
  if (policy && Object.hasOwn(policy, "certificateFiles")) fields.push("certificateFiles");
  check(policy && typeof policy === "object" && !Array.isArray(policy) &&
    Object.keys(policy).sort().join() === fields.sort().join() && policy.format === "dp-beget-clean-route-policy-v1" &&
    /^[0-9a-f-]{36}$/.test(policy.transactionId || "") && /^[0-9a-f]{40}$/.test(policy.commit || "") &&
    ["manifestSha256", "artifactSha256", "executableSha256", "unitFileSha256"].every(key => SHA.test(policy[key] || "")) &&
    ["unitFile", "executable", "adminSocket"].every(key => absolute(policy[key])), "invalid policy fields");
  validateCleanCaddyUnitInputs({ ...policy, pid: 2 });
  check(validateHostname(policy.domain) === policy.domain, "normalized policy domain required");
  validatePublicIpv4(policy.expectedIp);
  if (policy.certificateFiles !== undefined) {
    const cert = policy.certificateFiles;
    check(cert && typeof cert === "object" && !Array.isArray(cert) && Object.keys(cert).sort().join() === "certificate,key" &&
      absolute(cert.certificate) && absolute(cert.key) && cert.certificate !== cert.key &&
      ![cert.certificate, cert.key].includes(policy.adminSocket), "invalid certificate paths");
  }
  return policy;
}

// The policy contains no credentials, CA overrides, callbacks or PIDs. It
// pins proxy trust inputs beside the installation journal under root control.
export async function readCleanInstallRoutePolicy(policyPath) {
  check(process.getuid?.() === 0 && absolute(policyPath), "root and normalized private policy path required");
  const parent = path.dirname(policyPath), directory = await lstat(parent);
  check(directory.isDirectory() && directory.uid === 0 && (directory.mode & 0o777) === 0o700 &&
    await realpath(parent) === parent, "untrusted policy parent");
  const file = await open(policyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    check(before.isFile() && before.uid === 0 && before.nlink === 1 && (before.mode & 0o777) === 0o600 &&
      before.size > 0 && before.size <= 16384 && await realpath(policyPath) === policyPath, "untrusted policy file");
    const buffer = Buffer.alloc(16385), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const identity = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs];
    check(bytesRead === before.size && isDeepStrictEqual(identity(before), identity(await file.stat())) &&
      isDeepStrictEqual(identity(before), identity(await lstat(policyPath))), "policy changed during read");
    const policy = parseCleanInstallRoutePolicy(buffer.subarray(0, bytesRead));
    return { policy, identity: identity(before), sha256: createHash("sha256").update(buffer.subarray(0, bytesRead)).digest("hex") };
  } finally { await file.close(); }
}

async function mainPid(unitName) {
  const { stdout, stderr } = await exec("systemctl", ["show", unitName, "--property=MainPID", "--value"],
    { timeout: 5000, maxBuffer: 1024, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" } });
  check(!stderr.trim() && /^[1-9][0-9]*\n?$/.test(stdout) && Number.isSafeInteger(Number(stdout)) && Number(stdout) > 1,
    "running proxy PID unavailable");
  return Number(stdout);
}

async function workUid(user) {
  const { stdout, stderr } = await exec("id", ["-u", "--", user], { timeout: 5000, maxBuffer: 1024,
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" } });
  check(!stderr.trim() && /^[1-9][0-9]*\n?$/.test(stdout) && Number.isSafeInteger(Number(stdout)), "work UID unavailable");
  return Number(stdout);
}

export async function inspectCleanInstallRoute({ requestPath, journalPath, policyPath, trustDir,
  readRequest = readCleanPrivateRequest, readJournal = readCleanInstallJournal,
  readPolicy = readCleanInstallRoutePolicy, verify = verifyCleanInstallManifest,
  inspectPlan = inspectCleanInstallIdentityPlan, inspectRoute = inspectCleanCaddyHostRoute,
  inspectAuthProfile = inspectCleanInstallAuthProfile, inspectCreated = inspectCreatedCleanIdentities,
  readUid = workUid,
  readPid = mainPid, isRoot = () => process.getuid?.() === 0 } = {}) {
  check(isRoot() && [requestPath, journalPath, policyPath, trustDir].every(absolute), "root and explicit protected inputs required");
  check(new Set([requestPath, journalPath, policyPath]).size === 3 &&
    path.dirname(policyPath) === path.dirname(journalPath), "policy must be separate beside the journal");
  const request = parseCleanPrivateRequest(Buffer.from(JSON.stringify(await readRequest(requestPath))));
  const journal = await readJournal(journalPath), loaded = await readPolicy(policyPath);
  const policy = parseCleanInstallRoutePolicy(Buffer.from(JSON.stringify(loaded.policy)));
  check(SHA.test(loaded.sha256 || ""), "protected policy digest required");
  check(["owner-ready", "startup-intent", "startup-ready"].includes(journal.phase) &&
    request.journalPath === journalPath && request.trustDir === trustDir && request.workspace === journal.workspace &&
    request.releaseRoot === journal.releaseRoot && request.domain === journal.identityPlan?.domain &&
    request.domain === policy.domain && request.expectedIp === policy.expectedIp &&
    request.workspaceParent === path.dirname(journalPath) && policy.transactionId === journal.transactionId &&
    policy.manifestSha256 === journal.manifestSha256 && policy.artifactSha256 === journal.artifactSha256 &&
    policy.commit === journal.commit, "policy/request/journal identity mismatch");
  for (const key of ["workUser", "workGroup", "agentUser", "mcpUser", "ipcGroup", "allowedRoot"]) {
    check(request[key] === journal.identityPlan[key], "request service identity mismatch");
  }
  const identities = await inspectCreated({ plan: journal.identityPlan, transactionId: journal.transactionId });
  const uid = await readUid(request.workUser);
  check(identities?.identities === "journal-bound" && [uid, identities.agentUid, identities.mcpUid].every(value =>
    Number.isSafeInteger(value) && value > 0) && ![uid, identities.agentUid, identities.mcpUid].includes(policy.ownerUid) &&
    ![request.workUser, request.agentUser, request.mcpUser].includes(policy.ownerUser), "proxy must have a separate non-root identity");
  const signed = async () => {
    const candidate = await verify({ workspace: journal.workspace, manifestSha256: journal.manifestSha256, trustDir });
    check(candidate.artifactSha256 === journal.artifactSha256 && candidate.commit === journal.commit &&
      candidate.version === journal.version && isDeepStrictEqual(await inspectPlan({ workspace: journal.workspace,
        manifestSha256: journal.manifestSha256, trustDir }), journal.identityPlan), "signed installation binding changed");
    const auth = await inspectAuthProfile({ workspace: journal.workspace, manifestSha256: journal.manifestSha256, trustDir });
    check(auth.authMode === "oauth" && auth.ownerId === request.ownerId && auth.executionProfile === request.executionProfile,
      "original OAuth selection differs from the signed installation");
  };
  await signed();
  const pid = await readPid(policy.unitName), options = Object.fromEntries(PROXY.map(key => [key, policy[key]]));
  const report = await inspectRoute({ ...options, pid, domain: request.domain, expectedIp: request.expectedIp,
    ...(policy.certificateFiles ? { certificateFiles: policy.certificateFiles } : {}) });
  check(report?.pid === pid && report.ownerUid === policy.ownerUid && report.unitName === policy.unitName &&
    report.domain === policy.domain && report.expectedIp === policy.expectedIp &&
    report.caddySystemd === "main-process-bound" && report.caddyProcess === "socket-listener-bound" &&
    report.hostIngress === "dedicated-profile" && report.localAddress === "host-bound" &&
    report.localRoute === "local-loopback" && report.policyRules === "default-ipv4" &&
    report.caddyConfig === "closed-profile" && report.publicResponse === "closed-upstream" &&
    report.publicIngress === "unproven", "actual bound proxy/host/HTTPS evidence incomplete");
  await signed();
  check(isDeepStrictEqual(identities, await inspectCreated({ plan: journal.identityPlan, transactionId: journal.transactionId })) &&
    await readUid(request.workUser) === uid, "service identity changed around inspection");
  check(await readPid(policy.unitName) === pid && isDeepStrictEqual(request, await readRequest(requestPath)) &&
    isDeepStrictEqual(journal, await readJournal(journalPath)) && isDeepStrictEqual(loaded, await readPolicy(policyPath)),
    "protected installation or proxy changed around inspection");
  return { transactionId: journal.transactionId, commit: journal.commit, artifactSha256: journal.artifactSha256,
    manifestSha256: journal.manifestSha256, domain: request.domain, expectedIp: request.expectedIp,
    policySha256: loaded.sha256, installRoute: "signed-install-bound", publicIngress: "unproven",
    scope: "protected original request, signed installation journal/policy and actual dedicated Caddy host route; startup not authorized" };
}

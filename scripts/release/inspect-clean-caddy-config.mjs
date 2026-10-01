import { createHash } from "node:crypto";
import http from "node:http";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateHostname, validatePublicIpv4 } from "./host-preflight.mjs";
import { probeCleanPublicRoute } from "./probe-clean-public-route.mjs";

function socketPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) ||
      path.normalize(value) !== value || !/^\/[a-zA-Z0-9_./-]+$/.test(value)) {
    throw new Error("A normalized absolute Caddy admin socket path is required");
  }
  return value;
}

// Candidate dedicated bootstrap profile only. No file is installed and no
// daemon is reconfigured. This must not replace a shared proxy configuration.
export function renderClosedCleanCaddyConfig({ domain, adminSocket } = {}) {
  domain = validateHostname(domain);
  adminSocket = socketPath(adminSocket);
  return { admin: { listen: `unix/${adminSocket}` }, apps: { http: { servers: {
    dp_clean: { listen: [":443"], protocols: ["h1", "h2"],
      automatic_https: { disable_redirects: true },
      routes: [{ match: [{ host: [domain] }], terminal: true,
        handle: [{ handler: "static_response", status_code: 502,
          body: "DP clean ingress closed\n" }] }] },
  } } } };
}

export function validateClosedCleanCaddyConfig(bytes, options) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 65536) {
    throw new Error("Invalid Caddy configuration response size");
  }
  let config;
  try { config = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Invalid Caddy configuration JSON"); }
  const expected = renderClosedCleanCaddyConfig(options);
  if (!isDeepStrictEqual(config, expected)) {
    throw new Error("Caddy active configuration does not match the closed clean profile");
  }
  return { domain: validateHostname(options.domain),
    configSha256: createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
    caddyConfig: "closed-profile", publicIngress: "unproven" };
}

export async function inspectPrivateCaddyAdminSocket(adminSocket, ownerUid) {
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 1) {
    throw new Error("An explicit non-root Caddy service UID is required");
  }
  const parent = path.dirname(adminSocket);
  const [directory, socket] = await Promise.all([lstat(parent), lstat(adminSocket)]);
  if (!directory.isDirectory() || directory.uid !== ownerUid ||
      (directory.mode & 0o077) !== 0 || await realpath(parent) !== parent ||
      !socket.isSocket() || socket.uid !== ownerUid || (socket.mode & 0o077) !== 0 ||
      socket.nlink !== 1) {
    throw new Error("Caddy admin socket must be private and owned by the expected service UID");
  }
  return { directoryDev: directory.dev, directoryIno: directory.ino,
    socketDev: socket.dev, socketIno: socket.ino };
}

function readConfig(adminSocket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let response, done = false;
    const fail = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      response?.destroy();
      request.destroy();
      reject(new Error("Caddy active configuration read failed"));
    };
    const request = http.request({ socketPath: adminSocket, method: "GET", path: "/config/",
      agent: false, maxHeaderSize: 8192,
      headers: { Host: "localhost", Accept: "application/json", Connection: "close" } }, incoming => {
      response = incoming;
      response.on("error", fail);
      response.on("aborted", fail);
      if (response.statusCode !== 200 || response.headers.location !== undefined ||
          !/^application\/json(?:\s*;|$)/i.test(response.headers["content-type"] || "") ||
          response.headers["content-encoding"] !== undefined) { fail(); return; }
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        if (done) return;
        size += chunk.length;
        if (size > 65536) { fail(); return; }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (done) return;
        if (!response.complete) { fail(); return; }
        done = true;
        clearTimeout(timer);
        resolve(Buffer.concat(chunks));
      });
      response.on("close", () => { if (!done) fail(); });
    });
    const timer = setTimeout(fail, timeoutMs);
    request.on("error", fail);
    request.end();
  });
}

// GET only. Trust is limited to the explicitly supplied service UID and its
// protected socket, not the identity of the process actually serving :443.
// Never substitute this report for the closed-exclusive startup gate.
export async function inspectClosedCleanCaddyConfig({ domain, adminSocket, ownerUid,
  timeoutMs = 5000 } = {}) {
  const options = { domain: validateHostname(domain), adminSocket: socketPath(adminSocket) };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) {
    throw new Error("Invalid Caddy configuration read timeout");
  }
  const before = await inspectPrivateCaddyAdminSocket(options.adminSocket, ownerUid);
  const bytes = await readConfig(options.adminSocket, timeoutMs);
  const report = validateClosedCleanCaddyConfig(bytes, options);
  const after = await inspectPrivateCaddyAdminSocket(options.adminSocket, ownerUid);
  if (!isDeepStrictEqual(before, after)) {
    throw new Error("Caddy admin socket changed during configuration inspection");
  }
  return report;
}

// Correlate the public observation with matching protected admin snapshots.
// Process/listener ownership, NAT and other ingress remain outside this proof.
export async function inspectCleanCaddyRoute({ domain, expectedIp, adminSocket, ownerUid,
  inspectConfig = inspectClosedCleanCaddyConfig, probePublic = probeCleanPublicRoute } = {}) {
  domain = validateHostname(domain);
  expectedIp = validatePublicIpv4(expectedIp);
  const options = { domain, adminSocket: socketPath(adminSocket), ownerUid };
  const expected = validateClosedCleanCaddyConfig(
    Buffer.from(JSON.stringify(renderClosedCleanCaddyConfig(options))), options);
  const first = await inspectConfig(options);
  if (!isDeepStrictEqual(first, expected)) throw new Error("Closed Caddy configuration is unproven");
  const observation = await probePublic({ domain, expectedIp });
  if (observation?.domain !== domain || observation.expectedIp !== expectedIp ||
      observation.path !== "/mcp" || observation.status !== 502 ||
      observation.publicResponse !== "closed-upstream" || observation.publicIngress !== "unproven") {
    throw new Error("Closed Caddy public response binding is unproven");
  }
  const last = await inspectConfig(options);
  if (!isDeepStrictEqual(last, first)) throw new Error("Caddy configuration changed around the public probe");
  return { ...first, expectedIp, publicResponse: "closed-upstream",
    scope: "protected admin snapshots and public response only" };
}

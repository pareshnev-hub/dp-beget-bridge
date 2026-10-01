import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inspectCleanCaddyRoute, inspectPrivateCaddyAdminSocket } from "./inspect-clean-caddy-config.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
function requireProof(condition, reason) {
  if (!condition) throw new Error(`Caddy process binding: ${reason}`);
}

function inputs({ pid, ownerUid, executable, executableSha256, adminSocket }) {
  requireProof(Number.isSafeInteger(pid) && pid > 1 &&
    Number.isSafeInteger(ownerUid) && ownerUid > 0, "explicit process and non-root UID required");
  for (const filename of [executable, adminSocket]) {
    requireProof(typeof filename === "string" && path.isAbsolute(filename) &&
      path.normalize(filename) === filename && /^\/[a-zA-Z0-9_./-]+$/.test(filename),
    "normalized executable and socket paths required");
  }
  requireProof(SHA256.test(executableSha256 || ""), "pinned executable SHA-256 required");
}

export function caddyProcessStartTicks(output, pid) {
  requireProof(typeof output === "string" && output.length <= 16384 &&
    output.startsWith(`${pid} (`), "invalid process stat");
  const end = output.lastIndexOf(") ");
  const fields = output.slice(end + 2).trim().split(/\s+/);
  requireProof(end > 0 && ["R", "S", "D", "I"].includes(fields[0]) &&
    /^[1-9][0-9]*$/.test(fields[19] || ""), "process is stopped, dead or unidentified");
  return fields[19];
}

export function validateCaddyProcessUid(output, ownerUid) {
  requireProof(typeof output === "string" && output.length <= 65536, "invalid process status");
  const lines = output.split("\n").filter(line => line.startsWith("Uid:"));
  requireProof(lines.length === 1, "process UID is unavailable");
  const match = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(lines[0]);
  requireProof(match && match.slice(1).every(uid => Number(uid) === ownerUid),
    "real, effective, saved and filesystem UIDs must match");
}

// /proc/net inode numbers refer to kernel sockets, not the Unix pathname's
// filesystem inode. Bind the kernel inode to this process's open FD links.
export function validateCaddySocketInventory({ unix, tcp, tcp6, fdLinks, adminSocket, ownerUid }) {
  for (const text of [unix, tcp, tcp6]) {
    requireProof(typeof text === "string" && text.length <= 1024 * 1024,
      "socket table is unavailable or oversized");
  }
  const unixLines = unix.trim().split("\n");
  requireProof(/^Num\s+RefCount\s+Protocol\s+Flags\s+Type\s+St\s+Inode\s+Path\s*$/.test(unixLines.shift()),
    "unknown Unix socket table format");
  const admin = unixLines.map(line => line.trim().split(/\s+/)).filter(fields => fields[7] === adminSocket);
  requireProof(admin.length === 1 && admin[0].length === 8 &&
    admin[0][3] === "00010000" && admin[0][4] === "0001" && admin[0][5] === "01" &&
    /^[1-9][0-9]*$/.test(admin[0][6]), "admin socket is not one listening stream socket");
  const listeners = [];
  for (const [table, width] of [[tcp, 8], [tcp6, 32]]) {
    const lines = table.trim().split("\n");
    requireProof(/^\s*sl\s+local_address\s+/.test(lines.shift()), "unknown TCP table format");
    for (const line of lines) {
      if (!line.trim()) continue;
      const fields = line.trim().split(/\s+/);
      requireProof(fields.length >= 10 && /^\d+:$/.test(fields[0]) &&
        new RegExp(`^[0-9A-F]{${width}}:[0-9A-F]{4}$`, "i").test(fields[1]) &&
        /^[0-9A-F]{2}$/i.test(fields[3]), "invalid TCP socket row");
      if (fields[3].toUpperCase() !== "0A" || fields[1].slice(-4).toUpperCase() !== "01BB") continue;
      requireProof(fields[1].slice(0, width) === "0".repeat(width) &&
        Number(fields[7]) === ownerUid && /^[1-9][0-9]*$/.test(fields[9]),
      "public listener has unexpected address or UID");
      listeners.push(fields[9]);
    }
  }
  requireProof(listeners.length === 1, "exactly one host TCP listener on port 443 required");
  requireProof(Array.isArray(fdLinks) && fdLinks.length <= 4096 &&
    fdLinks.every(link => typeof link === "string"), "process FD inventory unavailable");
  const owned = new Set(fdLinks);
  requireProof(owned.has(`socket:[${admin[0][6]}]`) && owned.has(`socket:[${listeners[0]}]`),
    "admin socket and public listener are not owned by this process");
  return { adminKernelInode: admin[0][6], publicKernelInode: listeners[0] };
}

async function boundedRead(filename, limit) {
  const handle = await open(filename, constants.O_RDONLY);
  try {
    const chunks = [];
    let size = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - size));
      const { bytesRead } = await handle.read(chunk);
      if (bytesRead === 0) break;
      size += bytesRead;
      requireProof(size <= limit, "input exceeds inspection limit");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}

function fileIdentity(info) {
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
}

async function executableIdentity(executable, executableSha256, proc) {
  requireProof(await realpath(executable) === executable, "executable path contains a symlink");
  for (let parent = path.dirname(executable); ; parent = path.dirname(parent)) {
    const info = await lstat(parent);
    requireProof(info.isDirectory() && info.uid === 0 && (info.mode & 0o022) === 0,
      "executable parent is not root-controlled");
    if (parent === "/") break;
  }
  const before = await lstat(executable);
  requireProof(before.isFile() && before.uid === 0 && before.nlink === 1 &&
    (before.mode & 0o022) === 0 && (before.mode & 0o111) !== 0 && before.size > 0 &&
    before.size <= 128 * 1024 * 1024, "untrusted executable file");
  const sha = createHash("sha256").update(await boundedRead(executable, 128 * 1024 * 1024)).digest("hex");
  const after = await lstat(executable);
  const running = await stat(`${proc}/exe`);
  requireProof(sha === executableSha256 && isDeepStrictEqual(fileIdentity(before), fileIdentity(after)) &&
    running.dev === before.dev && running.ino === before.ino &&
    await readlink(`${proc}/exe`) === executable, "running executable does not match pinned bytes");
  return fileIdentity(before);
}

// Root read-only Linux inspection. No environment, command line or socket
// bodies are read. It does not assert absence of NAT or other public ingress.
export async function inspectCleanCaddyProcess(options = {}) {
  inputs(options);
  requireProof(process.platform === "linux" && process.getuid?.() === 0, "root Linux inspection required");
  const { pid, ownerUid, executable, executableSha256, adminSocket } = options;
  const proc = `/proc/${pid}`;
  const read = async (filename, limit = 1024 * 1024) => (await boundedRead(filename, limit)).toString("utf8");
  try {
    const startTicks = caddyProcessStartTicks(await read(`${proc}/stat`, 16384), pid);
    validateCaddyProcessUid(await read(`${proc}/status`, 65536), ownerUid);
    const netNamespace = await readlink(`${proc}/ns/net`);
    requireProof(netNamespace === await readlink("/proc/self/ns/net"), "process is in another network namespace");
    const binary = await executableIdentity(executable, executableSha256, proc);
    const socket = await inspectPrivateCaddyAdminSocket(adminSocket, ownerUid);
    const names = await readdir(`${proc}/fd`);
    requireProof(names.length <= 4096 && names.every(name => /^\d+$/.test(name)), "invalid process FD inventory");
    const fdLinks = await Promise.all(names.map(async name => {
      try { return await readlink(`${proc}/fd/${name}`); }
      catch (error) { if (error.code === "ENOENT") return "closed"; throw error; }
    }));
    const sockets = validateCaddySocketInventory({
      unix: await read(`${proc}/net/unix`), tcp: await read(`${proc}/net/tcp`),
      tcp6: await read(`${proc}/net/tcp6`), fdLinks, adminSocket, ownerUid });
    requireProof(caddyProcessStartTicks(await read(`${proc}/stat`, 16384), pid) === startTicks &&
      await readlink(`${proc}/ns/net`) === netNamespace &&
      isDeepStrictEqual(await inspectPrivateCaddyAdminSocket(adminSocket, ownerUid), socket),
    "process or admin socket changed during inspection");
    validateCaddyProcessUid(await read(`${proc}/status`, 65536), ownerUid);
    requireProof(isDeepStrictEqual(await executableIdentity(executable, executableSha256, proc), binary),
      "executable changed during inspection");
    return { pid, ownerUid, startTicks, executableSha256, binary, netNamespace, ...socket, ...sockets,
      caddyProcess: "socket-listener-bound", publicIngress: "unproven" };
  } catch (error) {
    if (error.message.startsWith("Caddy process binding:")) throw error;
    throw new Error("Caddy process binding: live process evidence unavailable");
  }
}

export async function inspectCleanCaddyProcessRoute({ inspectProcess = inspectCleanCaddyProcess,
  inspectRoute = inspectCleanCaddyRoute, ...options } = {}) {
  inputs(options);
  const first = await inspectProcess(options);
  requireProof(first?.pid === options.pid && first.ownerUid === options.ownerUid &&
    first.executableSha256 === options.executableSha256 && first.caddyProcess === "socket-listener-bound" &&
    first.publicIngress === "unproven", "process identity is unproven");
  const route = await inspectRoute(options);
  requireProof(route?.domain === options.domain && route.expectedIp === options.expectedIp &&
    route.caddyConfig === "closed-profile" && route.publicResponse === "closed-upstream" &&
    route.publicIngress === "unproven", "route evidence is unproven");
  const last = await inspectProcess(options);
  requireProof(isDeepStrictEqual(first, last), "process binding changed around route observation");
  return { ...route, pid: first.pid, ownerUid: first.ownerUid, startTicks: first.startTicks,
    executableSha256: first.executableSha256, caddyProcess: first.caddyProcess,
    scope: "one host process, admin socket, TCP 443, closed config and public response only" };
}

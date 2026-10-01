import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readdir, readlink } from "node:fs/promises";
import { isDeepStrictEqual, promisify } from "node:util";
import { inspectBegetLegacyBackends } from "./inspect-beget-oauth-nat.mjs";
import { inspectCleanCaddySystemd, validateCleanCaddyUnitInputs } from "./inspect-clean-caddy-systemd.mjs";
import { inspectCleanCaddyRoute } from "./inspect-clean-caddy-config.mjs";
import { inspectCleanCaddyAddress } from "./inspect-clean-caddy-address.mjs";

const exec = promisify(execFile);
function check(ok, reason) {
  if (!ok) throw new Error(`Clean Caddy host inventory: ${reason}`);
}
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function validateCleanCaddyHostListeners({ tcp, tcp6, udp, udp6, publicKernelInode, ownerUid }) {
  check(/^[1-9][0-9]*$/.test(publicKernelInode || "") && Number.isSafeInteger(ownerUid) && ownerUid > 0,
    "bound Caddy listener required");
  const inventory = [];
  let publicCount = 0;
  for (const [name, output, width] of [["tcp", tcp, 8], ["tcp6", tcp6, 32],
    ["udp", udp, 8], ["udp6", udp6, 32]]) {
    check(typeof output === "string" && output.length <= 1024 * 1024, "socket table unavailable");
    const lines = output.trim().split("\n");
    check(/^\s*sl\s+local_address\s+/.test(lines.shift()), "unknown socket table format");
    for (const line of lines) {
      if (!line.trim()) continue;
      const fields = line.trim().split(/\s+/);
      check(fields.length >= 10 && /^\d+:$/.test(fields[0]) &&
        new RegExp(`^[0-9A-F]{${width}}:[0-9A-F]{4}$`, "i").test(fields[1]) &&
        /^[0-9A-F]{2}$/i.test(fields[3]) && /^\d+$/.test(fields[7]) && /^\d+$/.test(fields[9]),
      "invalid socket table row");
      // Connected sockets cannot accept a new public ingress. Unconnected
      // UDP sockets use 07; TCP listeners use 0A in the kernel tables.
      if (fields[3].toUpperCase() !== (name.startsWith("tcp") ? "0A" : "07")) continue;
      const address = fields[1].slice(0, width).toUpperCase();
      const port = parseInt(fields[1].slice(-4), 16);
      const uid = Number(fields[7]);
      const loopback = width === 8 ? address.endsWith("7F") : address === "00000000000000000000000001000000";
      const wildcard = address === "0".repeat(width);
      if (loopback) {
        check(![80, 443].includes(port), "alternate loopback HTTP/TLS listener");
      } else if (name.startsWith("tcp") && port === 443) {
        check(wildcard && fields[9] === publicKernelInode && uid === ownerUid,
          "public TLS listener differs from bound Caddy");
        publicCount++;
      } else check(name.startsWith("tcp") && port === 22 && uid === 0,
        "unsupported non-loopback TCP or UDP listener");
      inventory.push([name, address, port, uid, fields[9]]);
    }
  }
  check(publicCount === 1, "exactly one bound public TLS listener required");
  inventory.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { listenersSha256: digest(inventory), listenerCount: inventory.length };
}

// Conservative dedicated-host profile: filter tables/chains and a limited
// set of non-routing expressions. NAT, flowtables, queues, jumps, verdict
// maps and unknown statements require a separately supported profile.
export function validateCleanCaddyNftRuleset(output) {
  check(typeof output === "string" && output.length <= 4 * 1024 * 1024, "nft inventory unavailable");
  let parsed;
  try { parsed = JSON.parse(output); } catch { check(false, "invalid nft JSON"); }
  check(parsed && Object.keys(parsed).length === 1 && Array.isArray(parsed.nftables) &&
    parsed.nftables.length <= 16384, "invalid nft inventory");
  const normalized = [];
  const tables = new Set(), chains = new Set();
  let metadata = 0;
  for (const item of parsed.nftables) {
    check(item && typeof item === "object" && Object.keys(item).length === 1, "invalid nft object");
    const [kind, value] = Object.entries(item)[0];
    check(value && typeof value === "object" && !Array.isArray(value), "invalid nft object body");
    if (kind === "metainfo") {
      check(++metadata === 1 && value.json_schema_version === 1, "unsupported nft schema");
      continue;
    }
    check(["table", "chain", "rule"].includes(kind) && ["ip", "ip6", "inet"].includes(value.family),
      "unsupported nft family or object");
    const clean = { ...value };
    delete clean.handle;
    if (kind === "table") {
      check(Object.keys(clean).every(key => ["family", "name"].includes(key)) &&
        typeof clean.name === "string" && clean.name.length > 0 && clean.name.length <= 128,
      "unsupported nft table attributes");
      const key = `${clean.family}/${clean.name}`;
      check(!tables.has(key), "duplicate nft table"); tables.add(key);
    } else {
      check(typeof clean.table === "string" && tables.has(`${clean.family}/${clean.table}`),
        "unbound nft table");
      if (kind === "chain") {
        check(Object.keys(clean).every(key => ["family", "table", "name", "type", "hook", "prio", "policy"].includes(key)) &&
          typeof clean.name === "string" && clean.name.length > 0 && clean.name.length <= 128,
        "unsupported nft chain attributes");
        if (Object.hasOwn(clean, "hook")) check(clean.type === "filter" &&
          ["input", "output", "forward"].includes(clean.hook) &&
          Number.isSafeInteger(clean.prio) && ["accept", "drop"].includes(clean.policy),
        "nft hook could reroute ingress");
        else check(!["type", "prio", "policy"].some(key => Object.hasOwn(clean, key)), "incomplete nft chain");
        const key = `${clean.family}/${clean.table}/${clean.name}`;
        check(!chains.has(key), "duplicate nft chain"); chains.add(key);
      } else {
        check(Object.keys(clean).every(key => ["family", "table", "chain", "expr", "comment"].includes(key)) &&
          chains.has(`${clean.family}/${clean.table}/${clean.chain}`) &&
          Array.isArray(clean.expr) && clean.expr.length > 0 && clean.expr.length <= 64,
        "unbound or invalid nft rule");
        clean.expr = clean.expr.map(expression => {
          check(expression && typeof expression === "object" && Object.keys(expression).length === 1,
            "invalid nft expression");
          const [statement, body] = Object.entries(expression)[0];
          check(["match", "counter", "accept", "drop", "reject", "limit"].includes(statement),
            "nft rule could reroute ingress");
          if (statement === "counter") {
            check(body && typeof body === "object" && !Array.isArray(body) &&
              Object.keys(body).every(key => ["packets", "bytes"].includes(key)) &&
              Object.values(body).every(count => Number.isSafeInteger(count) && count >= 0),
            "unsupported nft counter");
            return { counter: {} }; // Packet counters are volatile, not configuration.
          }
          if (["accept", "drop"].includes(statement)) check(body === null, "invalid nft verdict");
          if (statement === "match") check(body && typeof body === "object" &&
            Object.keys(body).length === 3 && ["left", "op", "right"].every(key => Object.hasOwn(body, key)) &&
            ["==", "!=", "in", "<", ">", "<=", ">=", "&"].includes(body.op), "invalid nft match");
          if (["reject", "limit"].includes(statement)) check(body && typeof body === "object" &&
            !Array.isArray(body), "invalid nft filter expression");
          return expression;
        });
      }
    }
    normalized.push({ [kind]: clean });
  }
  check(metadata === 1, "missing nft schema metadata");
  return { nftSha256: digest(normalized), nftObjects: normalized.length };
}

async function boundedRead(filename, limit = 1024 * 1024) {
  const handle = await open(filename, "r");
  try {
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) return buffer.subarray(0, size).toString("utf8");
      size += bytesRead;
      check(size <= limit, "input exceeds inspection limit");
    }
  } finally { await handle.close(); }
}

// Reading every process FD also rejects a second process which inherited
// Caddy's listeners. Failure to inspect a live process is not an empty list.
async function inspectExclusiveSocketOwners(pid, inodes) {
  const deadline = Date.now() + 15000;
  let totalFds = 0;
  const names = (await readdir("/proc")).filter(name => /^[1-9][0-9]*$/.test(name));
  check(names.length <= 16384, "process inventory exceeds limit");
  const target = new Set(inodes.map(inode => `socket:[${inode}]`));
  for (const name of names) {
    let fds;
    try { fds = await readdir(`/proc/${name}/fd`); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    check(fds.length <= 4096, "process FD inventory exceeds limit");
    totalFds += fds.length;
    check(totalFds <= 262144, "host FD inventory exceeds limit");
    for (const fd of fds) {
      check(Date.now() <= deadline, "host FD inspection deadline exceeded");
      let link;
      try { link = await readlink(`/proc/${name}/fd/${fd}`); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      check(!target.has(link) || Number(name) === pid, "another process owns a Caddy listening socket");
    }
  }
}

export async function inspectCleanCaddyHost({ pid, ownerUid, adminKernelInode, publicKernelInode } = {}) {
  check(process.platform === "linux" && process.getuid?.() === 0, "root Linux inspection required");
  check(Number.isSafeInteger(pid) && pid > 1 && /^[1-9][0-9]*$/.test(adminKernelInode || ""),
    "bound process and admin inode required");
  try {
    const namespace = await readlink(`/proc/${pid}/ns/net`);
    check(namespace === await readlink("/proc/self/ns/net"), "Caddy is outside host network namespace");
    const tables = {};
    for (const table of ["tcp", "tcp6", "udp", "udp6"]) tables[table] = await boundedRead(`/proc/net/${table}`);
    const listeners = validateCleanCaddyHostListeners({ ...tables, ownerUid, publicKernelInode });
    const { stdout, stderr } = await exec("nft", ["-j", "list", "ruleset"],
      { timeout: 12000, maxBuffer: 4 * 1024 * 1024 });
    check(!stderr.trim(), "nft inventory unavailable");
    const nft = validateCleanCaddyNftRuleset(stdout);
    await inspectBegetLegacyBackends(); // Must have no rules in either legacy family.
    await inspectExclusiveSocketOwners(pid, [adminKernelInode, publicKernelInode]);
    check(await readlink(`/proc/${pid}/ns/net`) === namespace, "network namespace changed during inspection");
    return { ...listeners, ...nft, netNamespace: namespace, legacyRules: "empty",
      socketOwners: "sole-process", hostIngress: "dedicated-profile", publicIngress: "unproven" };
  } catch (error) {
    if (error.message.startsWith("Clean Caddy host inventory:")) throw error;
    throw new Error("Clean Caddy host inventory: live host evidence unavailable");
  }
}

export async function inspectCleanCaddyHostRoute({ inspectSystemd = inspectCleanCaddySystemd,
  inspectHost = inspectCleanCaddyHost, inspectRoute = inspectCleanCaddyRoute,
  inspectAddress = inspectCleanCaddyAddress, ...options } = {}) {
  validateCleanCaddyUnitInputs(options);
  const first = await inspectSystemd(options);
  check(first?.pid === options.pid && first.ownerUid === options.ownerUid &&
    first.unitName === options.unitName && first.unitFileSha256 === options.unitFileSha256 &&
    first.executableSha256 === options.executableSha256 && first.caddySystemd === "main-process-bound" &&
    first.caddyProcess === "socket-listener-bound" && first.publicIngress === "unproven",
  "systemd process identity unproven");
  const host = await inspectHost(first);
  check(host?.hostIngress === "dedicated-profile" && host.socketOwners === "sole-process" &&
    host.legacyRules === "empty" && host.publicIngress === "unproven" &&
    host.netNamespace === first.netNamespace, "host ingress inventory unproven");
  const addressInputs = { expectedIp: options.expectedIp, netNamespace: first.netNamespace };
  const address = await inspectAddress(addressInputs);
  check(address?.expectedIp === options.expectedIp && address.netNamespace === first.netNamespace &&
    address.localAddress === "host-bound" && address.localRoute === "local-loopback" &&
    address.policyRules === "default-ipv4" && address.publicIngress === "unproven",
  "public address assignment is unproven");
  const route = await inspectRoute(options);
  check(route?.domain === options.domain && route.expectedIp === options.expectedIp &&
    route.caddyConfig === "closed-profile" && route.publicResponse === "closed-upstream" &&
    route.publicIngress === "unproven", "closed route observation unproven");
  check(isDeepStrictEqual(address, await inspectAddress(addressInputs)) &&
    isDeepStrictEqual(host, await inspectHost(first)) &&
    isDeepStrictEqual(first, await inspectSystemd(options)), "host or service changed around route observation");
  return { ...route, pid: first.pid, ownerUid: first.ownerUid, startTicks: first.startTicks,
    unitName: first.unitName, invocationId: first.invocationId, caddySystemd: first.caddySystemd,
    caddyProcess: first.caddyProcess, ...host, ...address,
    scope: "local public IPv4/default routing, dedicated host sockets, filter-only nft/empty legacy, pinned Caddy/systemd and closed response" };
}

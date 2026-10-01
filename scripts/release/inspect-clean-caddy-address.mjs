import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readlink } from "node:fs/promises";
import { promisify } from "node:util";
import { validatePublicIpv4 } from "./host-preflight.mjs";

const exec = promisify(execFile);
function check(condition, reason) {
  if (!condition) throw new Error(`Clean Caddy address binding: ${reason}`);
}
function jsonArray(output, limit, count) {
  check(typeof output === "string" && output.length <= limit, "inventory unavailable or oversized");
  let value;
  try { value = JSON.parse(output); } catch { check(false, "invalid inventory JSON"); }
  check(Array.isArray(value) && value.length <= count, "invalid inventory");
  return value;
}

// Dedicated directly addressed IPv4 host only. A DNS/TLS probe to a remote
// server must not be correlated with an unrelated local Caddy process.
export function validateCleanCaddyAddress({ addresses, rules, route, expectedIp } = {}) {
  expectedIp = validatePublicIpv4(expectedIp);
  const interfaces = jsonArray(addresses, 1024 * 1024, 256);
  const matches = [];
  for (const entry of interfaces) {
    check(entry && typeof entry === "object" && Number.isSafeInteger(entry.ifindex) && entry.ifindex > 0 &&
      typeof entry.ifname === "string" && Array.isArray(entry.flags) && Array.isArray(entry.addr_info) &&
      entry.addr_info.length <= 256, "invalid address inventory");
    for (const address of entry.addr_info) {
      check(address && typeof address === "object", "invalid address entry");
      if (address.family !== "inet" || address.local !== expectedIp) continue;
      check(entry.ifname !== "lo" && !entry.flags.includes("LOOPBACK") && entry.flags.includes("UP") &&
        address.scope === "global" && Number.isSafeInteger(address.prefixlen) && address.prefixlen > 0 &&
        address.prefixlen <= 32 && address.tentative !== true && address.dadfailed !== true,
      "public address is not assigned to an up non-loopback interface");
      matches.push({ ifindex: entry.ifindex, ifname: entry.ifname,
        flags: [...entry.flags].sort(), address: expectedIp, prefixlen: address.prefixlen, scope: address.scope });
    }
  }
  check(matches.length === 1, "exactly one local public address assignment required");
  const policy = jsonArray(rules, 65536, 256);
  const expected = [{ priority: 0, src: "all", table: "local" },
    { priority: 32766, src: "all", table: "main" }, { priority: 32767, src: "all", table: "default" }];
  check(policy.length === expected.length && policy.every((rule, index) => rule &&
    Object.keys(rule).every(key => ["priority", "src", "table", "protocol"].includes(key)) &&
    Object.entries(expected[index]).every(([key, value]) => rule[key] === value)),
  "IPv4 policy routing differs from the dedicated default profile");
  const lookup = jsonArray(route, 65536, 16);
  const local = lookup[0];
  check(lookup.length === 1 && local &&
    Object.keys(local).every(key => ["type", "dst", "dev", "prefsrc", "flags", "uid", "cache"].includes(key)) &&
    local.type === "local" && local.dst === expectedIp && local.dev === "lo" && local.prefsrc === expectedIp &&
    Array.isArray(local.flags) && local.flags.length === 0 &&
    (!Object.hasOwn(local, "uid") || local.uid === 0) && Array.isArray(local.cache) &&
    local.cache.length === 1 && local.cache[0] === "local", "expected public IP does not route to this host");
  return { expectedIp, localAddress: "host-bound", interfaceIndex: matches[0].ifindex,
    addressSha256: createHash("sha256").update(JSON.stringify(matches[0])).digest("hex"),
    localRoute: "local-loopback", policyRules: "default-ipv4", publicIngress: "unproven" };
}

export async function inspectCleanCaddyAddress({ expectedIp, netNamespace } = {}) {
  validatePublicIpv4(expectedIp);
  check(process.platform === "linux" && process.getuid?.() === 0 &&
    /^net:\[[1-9][0-9]*\]$/.test(netNamespace || ""), "root Linux namespace binding required");
  try {
    check(await readlink("/proc/self/ns/net") === netNamespace, "network namespace does not match Caddy");
    const outputs = [];
    for (const args of [["-j", "-4", "addr", "show"], ["-j", "-4", "rule", "show"],
      ["-j", "-4", "route", "get", expectedIp]]) {
      const { stdout, stderr } = await exec("ip", args, { timeout: 5000, maxBuffer: 1024 * 1024,
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" } });
      check(!stderr.trim(), "address inventory unavailable"); outputs.push(stdout);
    }
    check(await readlink("/proc/self/ns/net") === netNamespace, "network namespace changed during inspection");
    return { ...validateCleanCaddyAddress({ addresses: outputs[0], rules: outputs[1], route: outputs[2], expectedIp }),
      netNamespace };
  } catch (error) {
    if (error.message.startsWith("Clean Caddy address binding:")) throw error;
    throw new Error("Clean Caddy address binding: live address evidence unavailable");
  }
}

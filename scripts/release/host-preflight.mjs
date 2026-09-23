#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promises as dns } from "node:dns";
import { readFile, lstat, realpath } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const excludedIps = new BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
]) excludedIps.addSubnet(address, bits, "ipv4");

export function validateHostname(domain) {
  if (typeof domain !== "string" || domain.length > 253 || domain.length < 4 ||
      !domain.includes(".") || isIP(domain) || !/^[a-zA-Z0-9.-]+$/.test(domain) ||
      domain.split(".").some(label => label.length < 1 || label.length > 63 ||
        !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label))) {
    throw new Error("Domain must be a valid DNS hostname");
  }
  return domain.toLowerCase();
}

export function assertSupportedOs(osRelease) {
  const fields = Object.fromEntries(osRelease.split("\n").filter(line => /^[A-Z_]+=/.test(line))
    .map(line => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/g, "")]; }));
  if (fields.ID !== "ubuntu" || fields.VERSION_ID !== "24.04") {
    throw new Error("Supported R0004 host profile is Ubuntu 24.04 LTS");
  }
}

function probeTls(domain, ip) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: ip, port: 443, servername: domain, rejectUnauthorized: true });
    const fail = () => { socket.destroy(); reject(new Error("HTTPS certificate or connection check failed")); };
    socket.setTimeout(5000, fail);
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      if (!socket.authorized) { fail(); return; }
      socket.end();
      resolve();
    });
  });
}

export async function checkDnsAndTls({ domain, expectedIp,
  resolve4 = dns.resolve4, resolve6 = dns.resolve6, checkTls = probeTls }) {
  domain = validateHostname(domain);
  if (isIP(expectedIp) !== 4 || excludedIps.check(expectedIp, "ipv4")) {
    throw new Error("Expected public IPv4 address is required");
  }
  const lookup = async resolve => {
    try { return await resolve(domain); }
    catch (error) {
      if (["ENODATA", "ENOTFOUND", "ENODOMAIN"].includes(error.code)) return [];
      throw new Error("DNS lookup failed");
    }
  };
  const [ipv4, ipv6] = await Promise.all([lookup(resolve4), lookup(resolve6)]);
  if (ipv4.length !== 1 || ipv4[0] !== expectedIp || ipv6.length > 0) {
    throw new Error("DNS must point exclusively to the expected VPS IPv4 address");
  }
  await checkTls(domain, expectedIp);
  return { domain, expectedIp, dns: "pass", tls: "pass" };
}

export async function preflightHost({ domain, expectedIp, workUser, allowedRoot }) {
  const hostname = validateHostname(domain);
  if (os.platform() !== "linux") throw new Error("Linux is required");
  assertSupportedOs(await readFile("/etc/os-release", "utf8"));
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22 or newer is required");
  if (!workUser || !/^[a-z_][a-z0-9_-]*[$]?$/.test(workUser)) throw new Error("A work user is required");
  const { stdout: uidText } = await exec("id", ["-u", workUser]);
  if (Number(uidText.trim()) === 0) throw new Error("Root cannot be the work identity");
  if (!path.isAbsolute(allowedRoot || "")) throw new Error("Allowed root must be an absolute directory");
  const root = path.resolve(allowedRoot);
  const info = await lstat(root);
  if (!info.isDirectory() || (await realpath(root)) !== root) {
    throw new Error("Allowed root must be a real directory without symlink components");
  }
  for (const binary of ["tmux", "systemctl", "openssl", "tar", "git"]) {
    try { await exec("which", [binary]); }
    catch { throw new Error(`Missing host dependency: ${binary}`); }
  }
  return await checkDnsAndTls({ domain: hostname, expectedIp });
}

async function main(args) {
  if (args.length !== 8 || args[0] !== "--domain" || args[2] !== "--expected-ip" ||
      args[4] !== "--work-user" || args[6] !== "--allowed-root") {
    throw new Error("Usage: host-preflight --domain HOST --expected-ip IPV4 --work-user USER --allowed-root ABSOLUTE_DIRECTORY");
  }
  const result = await preflightHost({ domain: args[1], expectedIp: args[3], workUser: args[5], allowedRoot: args[7] });
  console.log(`R0004 host preflight passed: Ubuntu 24.04, non-root work identity, dependencies, DNS and HTTPS for ${result.domain}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`R0004 host preflight failed: ${error.message}`);
    process.exitCode = 1;
  });
}

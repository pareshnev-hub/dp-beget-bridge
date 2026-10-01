import test from "node:test";
import assert from "node:assert/strict";
import { caddyProcessStartTicks, validateCaddyProcessUid, validateCaddySocketInventory,
  inspectCleanCaddyProcess, inspectCleanCaddyProcessRoute } from "../scripts/release/inspect-clean-caddy-process.mjs";

const options = { pid: 4321, ownerUid: 1001, executable: "/usr/bin/caddy",
  executableSha256: "a".repeat(64), adminSocket: "/run/caddy-private/admin.sock",
  domain: "bridge.example.com", expectedIp: "1.1.1.1" };
const unixHeader = "Num       RefCount Protocol Flags    Type St Inode Path\n";
const tcpHeader = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n";
const tcpRow = (address = "00000000:01BB", inode = "2000", uid = "1001", state = "0A") =>
  `0: ${address} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 ${uid} 0 ${inode}\n`;
function inventory() {
  return { unix: unixHeader + `00000000: 00000002 00000000 00010000 0001 01 1000 ${options.adminSocket}\n`,
    tcp: tcpHeader + tcpRow(), tcp6: tcpHeader,
    fdLinks: ["socket:[1000]", "socket:[2000]", "/dev/null"],
    adminSocket: options.adminSocket, ownerUid: options.ownerUid };
}
function processStat(state = "S", ticks = "100000") {
  const fields = Array(20).fill("0");
  fields[0] = state; fields[19] = ticks;
  return `${options.pid} (caddy ) worker) ${fields.join(" ")}\n`;
}

test("OPS-01: process identity uses birth ticks and all four non-root UIDs", () => {
  assert.equal(caddyProcessStartTicks(processStat(), options.pid), "100000");
  for (const state of ["Z", "T", "t", "X"]) {
    assert.throws(() => caddyProcessStartTicks(processStat(state), options.pid), /stopped, dead/);
  }
  assert.throws(() => caddyProcessStartTicks(processStat(), 4322), /invalid process/);
  assert.throws(() => caddyProcessStartTicks(processStat("S", "0"), options.pid), /unidentified/);
  validateCaddyProcessUid("Name: caddy\nUid:\t1001\t1001\t1001\t1001\n", 1001);
  for (const value of ["", "Uid: 1001 0 1001 1001\n", "Uid: 1001 1001 0 1001\n",
    "Uid: 1001 1001 1001 0\n", "Uid: 1001 1001 1001 1001\nUid: 1001 1001 1001 1001\n"]) {
    assert.throws(() => validateCaddyProcessUid(value, 1001), /UID/);
  }
});

test("OPS-01: the same PID owns a listening admin socket and the sole host TCP 443 inode", () => {
  assert.deepEqual(validateCaddySocketInventory(inventory()),
    { adminKernelInode: "1000", publicKernelInode: "2000" });
  const v6 = { ...inventory(), tcp: tcpHeader, tcp6: tcpHeader + tcpRow(`${"0".repeat(32)}:01BB`) };
  assert.deepEqual(validateCaddySocketInventory(v6),
    { adminKernelInode: "1000", publicKernelInode: "2000" });
  for (const fdLinks of [["socket:[1000]"], ["socket:[2000]"], ["socket:[9999]"]]) {
    assert.throws(() => validateCaddySocketInventory({ ...inventory(), fdLinks }), /not owned/);
  }
});

test("OPS-01: ambiguous, foreign, inactive and malformed socket inventories fail closed", () => {
  const fixture = inventory();
  const cases = [
    { tcp: tcpHeader }, { tcp: fixture.tcp + tcpRow("00000000:01BB", "2001") },
    { tcp6: tcpHeader + tcpRow(`${"0".repeat(32)}:01BB`, "2001") },
    { tcp: tcpHeader + tcpRow("0100007F:01BB") },
    { tcp: tcpHeader + tcpRow("00000000:01BB", "2000", "0") },
    { tcp: tcpHeader + tcpRow("00000000:01BB", "2000", "1001", "01") },
    { tcp: "unknown format\n" }, { tcp: tcpHeader + "truncated\n" },
    { unix: fixture.unix + fixture.unix.split("\n")[1] + "\n" },
    { unix: fixture.unix.replace("00010000", "00000000") },
    { unix: fixture.unix.replace("0001 01", "0002 01") },
    { unix: fixture.unix.replace(options.adminSocket, "/run/other.sock") },
    { unix: "invalid header\n" }, { fdLinks: [] },
  ];
  for (const change of cases) assert.throws(() => validateCaddySocketInventory({ ...fixture, ...change }),
    /Caddy process binding:/);
});

test("OPS-01: process and pinned executable inputs are checked before live inspection", async () => {
  for (const change of [{ pid: 1 }, { pid: "4321" }, { ownerUid: 0 },
    { executable: "/usr/../bin/caddy" }, { executableSha256: "unknown" }, { adminSocket: "relative" }]) {
    await assert.rejects(inspectCleanCaddyProcess({ ...options, ...change }), /required/);
  }
});

test("OPS-01: stable process binding surrounds closed config/public observation and remains unproven ingress", async () => {
  const identity = { pid: options.pid, ownerUid: options.ownerUid, startTicks: "100000",
    executableSha256: options.executableSha256, publicKernelInode: "2000",
    caddyProcess: "socket-listener-bound", publicIngress: "unproven" };
  const route = { domain: options.domain, expectedIp: options.expectedIp,
    caddyConfig: "closed-profile", publicResponse: "closed-upstream", publicIngress: "unproven" };
  const calls = [];
  const fixture = { ...options,
    inspectProcess: async () => { calls.push("process"); return identity; },
    inspectRoute: async () => { calls.push("route"); return route; } };
  assert.equal((await inspectCleanCaddyProcessRoute(fixture)).publicIngress, "unproven");
  assert.deepEqual(calls, ["process", "route", "process"]);
  for (const change of [{ startTicks: "100001" }, { publicKernelInode: "2001" },
    { executableSha256: "b".repeat(64) }, { pid: 9999 }]) {
    let count = 0;
    await assert.rejects(inspectCleanCaddyProcessRoute({ ...fixture,
      inspectProcess: async () => ++count === 1 ? identity : { ...identity, ...change } }), /changed around/);
  }
  await assert.rejects(inspectCleanCaddyProcessRoute({ ...fixture,
    inspectRoute: async () => ({ ...route, domain: "other.example.com" }) }), /route evidence/);
  await assert.rejects(inspectCleanCaddyProcessRoute({ ...fixture,
    inspectProcess: async () => ({ ...identity, ownerUid: 0 }),
    inspectRoute: () => assert.fail("invalid identity reached route") }), /identity is unproven/);
});

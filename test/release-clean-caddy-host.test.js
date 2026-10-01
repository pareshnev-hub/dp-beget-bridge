import test from "node:test";
import assert from "node:assert/strict";
import { validateCleanCaddySystemdSnapshot, validateCleanCaddyUnitInputs } from "../scripts/release/inspect-clean-caddy-systemd.mjs";
import { validateCleanCaddyHostListeners, validateCleanCaddyNftRuleset,
  inspectCleanCaddyHostRoute } from "../scripts/release/inspect-clean-caddy-host.mjs";

const options = { unitName: "dp-clean-caddy.service", unitFile: "/etc/systemd/system/dp-clean-caddy.service",
  unitFileSha256: "b".repeat(64), ownerUser: "caddy", ownerUid: 1001, pid: 4321,
  executableSha256: "a".repeat(64), domain: "bridge.example.com", expectedIp: "1.1.1.1" };
const controlGroup = `/system.slice/${options.unitName}`;
const manager = { Id: options.unitName, LoadState: "loaded", ActiveState: "active", SubState: "running",
  MainPID: "4321", ControlPID: "0", ControlGroup: controlGroup, InvocationID: "c".repeat(32),
  User: "caddy", FragmentPath: options.unitFile, DropInPaths: "", Transient: "no", NeedDaemonReload: "no" };
const show = values => Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
const cgroup = `0::${controlGroup}\n`;

test("OPS-01: loaded Caddy service binds pinned fragment, main PID, invocation, user and unified cgroup", () => {
  const report = validateCleanCaddySystemdSnapshot(show(manager), cgroup, options);
  assert.equal(report.caddySystemd, "main-process-bound");
  for (const change of [{ Id: "alias.service" }, { LoadState: "not-found" }, { ActiveState: "inactive" },
    { SubState: "exited" }, { MainPID: "4322" }, { ControlPID: "20" }, { User: "root" },
    { FragmentPath: "/run/other.service" }, { DropInPaths: "/run/override.conf" },
    { Transient: "yes" }, { NeedDaemonReload: "yes" }, { InvocationID: "0".repeat(32) },
    { ControlGroup: "/other.slice/dp-clean-caddy.service" }]) {
    assert.throws(() => validateCleanCaddySystemdSnapshot(show({ ...manager, ...change }), cgroup, options),
      /Caddy systemd binding:/);
  }
  for (const value of ["", "0::/other.slice\n", `0::${controlGroup}/child\n`, `0::${controlGroup}\n1:cpu:/legacy\n`]) {
    assert.throws(() => validateCleanCaddySystemdSnapshot(show(manager), value, options), /cgroup/);
  }
  assert.throws(() => validateCleanCaddySystemdSnapshot(show(manager) + "MainPID=4321\n", cgroup, options), /invalid/);
  assert.throws(() => validateCleanCaddySystemdSnapshot(show(manager).replace("User=caddy\n", ""), cgroup, options), /incomplete/);
  for (const change of [{ unitName: "--help" }, { unitFile: "/tmp/other.service" },
    { unitFileSha256: "x" }, { ownerUser: "root!" }, { ownerUid: 0 }, { pid: 1 }]) {
    assert.throws(() => validateCleanCaddyUnitInputs({ ...options, ...change }), /required/);
  }
});

const header = "  sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode\n";
const row = (address, uid = 1001, inode = 2000, state = "0A") =>
  `0: ${address} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 ${uid} 0 ${inode}\n`;
const listeners = () => ({ tcp: header + row("00000000:01BB") + row("00000000:0016", 0, 2001) + row("0100007F:2253", 1002, 2002),
  tcp6: header, udp: header + row("0100007F:0035", 0, 2003, "07"), udp6: header,
  publicKernelInode: "2000", ownerUid: 1001 });

test("OPS-01: dedicated host allows only bound Caddy, root SSH and non-web loopback listeners", () => {
  const report = validateCleanCaddyHostListeners(listeners());
  assert.equal(report.listenerCount, 4);
  assert.match(report.listenersSha256, /^[0-9a-f]{64}$/);
  const v6 = { ...listeners(), tcp: header, tcp6: header + row(`${"0".repeat(32)}:01BB`) };
  assert.equal(validateCleanCaddyHostListeners(v6).listenerCount, 2);
  const fixture = listeners();
  for (const change of [{ tcp: header }, { tcp: fixture.tcp + row("00000000:1F90") },
    { tcp: fixture.tcp + row("0100007F:01BB", 1002, 3000) },
    { tcp: fixture.tcp + row("00000000:0050", 0, 3000) },
    { udp: header + row("00000000:01BB", 1001, 3000, "07") },
    { udp6: header + row(`${"0".repeat(32)}:0035`, 0, 3000, "07") },
    { tcp6: header + row(`${"0".repeat(32)}:01BB`, 1001, 3000) },
    { tcp: fixture.tcp.replace("1001 0 2000", "1002 0 2000") },
    { tcp: fixture.tcp.replace("0 0 2001", "1001 0 2001") },
    { tcp: header + "truncated\n" }, { publicKernelInode: "3000" }]) {
    assert.throws(() => validateCleanCaddyHostListeners({ ...fixture, ...change }), /Clean Caddy host inventory:/);
  }
});

const metadata = { metainfo: { json_schema_version: 1 } };
const table = { table: { family: "inet", name: "filter", handle: 1 } };
const chain = { chain: { family: "inet", table: "filter", name: "input", handle: 2,
  type: "filter", hook: "input", prio: 0, policy: "drop" } };
const rule = expr => ({ rule: { family: "inet", table: "filter", chain: "input", handle: 3, expr } });
const nft = items => JSON.stringify({ nftables: [metadata, ...items] });

test("OPS-01: nft inventory accepts filter-only configuration and ignores volatile counters and handles", () => {
  assert.equal(validateCleanCaddyNftRuleset(nft([])).nftObjects, 0);
  const match = { match: { op: "==", left: { payload: { protocol: "tcp", field: "dport" } }, right: 22 } };
  const report = validateCleanCaddyNftRuleset(nft([table, chain, rule([match, { counter: { packets: 1, bytes: 20 } }, { accept: null }])]));
  assert.equal(report.nftObjects, 3);
  const changed = { ...table, table: { ...table.table, handle: 999 } };
  assert.deepEqual(validateCleanCaddyNftRuleset(nft([changed, chain, rule([match, { counter: { packets: 9, bytes: 200 } }, { accept: null }])])), report);
  for (const statement of ["dnat", "snat", "redirect", "tproxy", "queue", "jump", "goto", "vmap", "mangle", "notrack", "dup", "fwd"]) {
    assert.throws(() => validateCleanCaddyNftRuleset(nft([table, chain, rule([{ [statement]: {} }])])), /reroute/);
  }
  for (const item of [{ flowtable: { family: "inet" } }, { set: { family: "inet" } },
    { chain: { ...chain.chain, hook: "prerouting", type: "nat" } },
    { table: { ...table.table, family: "netdev" } },
    { table: { ...table.table, flags: ["dormant"] } },
    rule([{ accept: {} }]), rule([{ counter: { packets: -1 } }])]) {
    assert.throws(() => validateCleanCaddyNftRuleset(nft([table, chain, item])), /Clean Caddy host inventory:/);
  }
  for (const value of ["", "{", JSON.stringify({ nftables: [] }), nft([table, table]),
    JSON.stringify({ nftables: [metadata, metadata] }), nft([chain]), nft([table, rule([{ accept: null }])])]) {
    assert.throws(() => validateCleanCaddyNftRuleset(value), /Clean Caddy host inventory:/);
  }
});

test("OPS-01: matching service and host snapshots bracket the public route; drift and forged statuses reject", async () => {
  const service = { ...options, startTicks: "100", invocationId: "c".repeat(32), netNamespace: "net:[10]",
    caddyProcess: "socket-listener-bound", caddySystemd: "main-process-bound", publicIngress: "unproven" };
  const host = { listenersSha256: "d".repeat(64), nftSha256: "e".repeat(64), netNamespace: service.netNamespace,
    hostIngress: "dedicated-profile", socketOwners: "sole-process", legacyRules: "empty", publicIngress: "unproven" };
  const route = { domain: options.domain, expectedIp: options.expectedIp, caddyConfig: "closed-profile",
    publicResponse: "closed-upstream", publicIngress: "unproven" };
  const calls = [];
  const fixture = { ...options, inspectSystemd: async () => { calls.push("systemd"); return service; },
    inspectHost: async () => { calls.push("host"); return host; },
    inspectRoute: async () => { calls.push("route"); return route; } };
  assert.equal((await inspectCleanCaddyHostRoute(fixture)).publicIngress, "unproven");
  assert.deepEqual(calls, ["systemd", "host", "route", "host", "systemd"]);
  for (const change of [{ nftSha256: "f".repeat(64) }, { listenersSha256: "f".repeat(64) }, { netNamespace: "net:[11]" }]) {
    let count = 0;
    await assert.rejects(inspectCleanCaddyHostRoute({ ...fixture,
      inspectHost: async () => ++count === 1 ? host : { ...host, ...change } }), /changed around/);
  }
  let count = 0;
  await assert.rejects(inspectCleanCaddyHostRoute({ ...fixture,
    inspectSystemd: async () => ++count === 1 ? service : { ...service, invocationId: "f".repeat(32) } }), /changed around/);
  await assert.rejects(inspectCleanCaddyHostRoute({ ...fixture, inspectHost: async () => ({ ...host, socketOwners: "unknown" }),
    inspectRoute: () => assert.fail("invalid host reached public route") }), /host ingress/);
  await assert.rejects(inspectCleanCaddyHostRoute({ ...fixture,
    inspectSystemd: async () => ({ ...service, unitFileSha256: "f".repeat(64) }) }), /identity unproven/);
  await assert.rejects(inspectCleanCaddyHostRoute({ ...fixture,
    inspectRoute: async () => ({ ...route, domain: "other.example.com" }) }), /observation unproven/);
});

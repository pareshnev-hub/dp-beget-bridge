import test from "node:test";
import assert from "node:assert/strict";
import { validateCleanCaddyAddress } from "../scripts/release/inspect-clean-caddy-address.mjs";

const expectedIp = "1.1.1.1";
const policy = [{ priority: 0, src: "all", table: "local" },
  { priority: 32766, src: "all", table: "main" }, { priority: 32767, src: "all", table: "default" }];
const address = { family: "inet", local: expectedIp, prefixlen: 32, scope: "global" };
const network = { ifindex: 2, ifname: "eth0", flags: ["UP", "LOWER_UP"], addr_info: [address] };
const local = { type: "local", dst: expectedIp, dev: "lo", prefsrc: expectedIp, flags: [], uid: 0, cache: ["local"] };
const encode = JSON.stringify;
const inputs = changes => ({ addresses: encode([network]), rules: encode(policy), route: encode([local]), expectedIp, ...changes });

test("OPS-01: Caddy public target binds exactly one up local interface and default local route", () => {
  const report = validateCleanCaddyAddress(inputs());
  assert.equal(report.localAddress, "host-bound");
  assert.equal(report.localRoute, "local-loopback");
  assert.equal(report.policyRules, "default-ipv4");
  assert.equal(report.publicIngress, "unproven");
  assert.match(report.addressSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(validateCleanCaddyAddress(inputs({ addresses: encode([{ ...network, flags: ["LOWER_UP", "UP"] }]) })), report);
});

test("OPS-01: foreign, absent, duplicate, loopback, down and incomplete public address assignments reject", () => {
  for (const entries of [[], [network, network], [{ ...network, ifname: "lo" }],
    [{ ...network, flags: ["UP", "LOOPBACK"] }], [{ ...network, flags: ["LOWER_UP"] }],
    [{ ...network, addr_info: [{ ...address, local: "8.8.8.8" }] }],
    [{ ...network, addr_info: [{ ...address, scope: "host" }] }],
    [{ ...network, addr_info: [{ ...address, prefixlen: 0 }] }],
    [{ ...network, addr_info: [{ ...address, tentative: true }] }],
    [{ ...network, addr_info: [{ ...address, dadfailed: true }] }], [{ ifindex: 2 }]]) {
    assert.throws(() => validateCleanCaddyAddress(inputs({ addresses: encode(entries) })), /address binding/);
  }
  assert.throws(() => validateCleanCaddyAddress(inputs({ expectedIp: "127.0.0.1" })), /public IPv4/);
});

test("OPS-01: policy routing, remote gateway, mismatched source and route modifiers cannot impersonate local Caddy", () => {
  for (const rules of [[], policy.slice(1), [...policy, { priority: 100, src: "all", table: "custom" }],
    [{ ...policy[0], priority: 1 }, ...policy.slice(1)],
    [{ ...policy[0], fwmark: "0x1" }, ...policy.slice(1)],
    [{ ...policy[0], src: "10.0.0.0/8" }, ...policy.slice(1)]]) {
    assert.throws(() => validateCleanCaddyAddress(inputs({ rules: encode(rules) })), /policy routing/);
  }
  for (const change of [{ type: "unicast" }, { gateway: "8.8.8.8" }, { dev: "eth0" },
    { dst: "8.8.8.8" }, { prefsrc: "8.8.8.8" }, { uid: 1001 },
    { flags: ["onlink"] }, { cache: [] }, { encap: {} }, { multipath: [] }]) {
    assert.throws(() => validateCleanCaddyAddress(inputs({ route: encode([{ ...local, ...change }]) })), /route to this host/);
  }
  assert.throws(() => validateCleanCaddyAddress(inputs({ route: encode([local, local]) })), /route to this host/);
});

test("OPS-01: malformed and oversized address/rule/route inventories fail", () => {
  for (const key of ["addresses", "rules", "route"]) {
    for (const value of ["", "{", "null", "{}", " ".repeat(1024 * 1024 + 1)]) {
      assert.throws(() => validateCleanCaddyAddress(inputs({ [key]: value })), /address binding/);
    }
  }
});

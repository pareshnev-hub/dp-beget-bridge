import test from "node:test";
import assert from "node:assert/strict";
import { assertSupportedOs, checkDnsAndTls, validateHostname } from "../scripts/release/host-preflight.mjs";

test("OPS-04: release domain and host profile reject unsafe or unsupported input", () => {
  assert.equal(validateHostname("Bridge.Example.com"), "bridge.example.com");
  for (const bad of ["bridge\nDP_AGENT_TOKEN=bad.example", "https://bridge.example", "a..example", "-bad.example", "127.0.0.1"]) {
    assert.throws(() => validateHostname(bad), /Domain/);
  }
  assert.doesNotThrow(() => assertSupportedOs('ID=ubuntu\nVERSION_ID="24.04"\n'));
  assert.throws(() => assertSupportedOs("ID=debian\nVERSION_ID=12\n"), /Ubuntu 24.04/);
});

test("OPS-04: wrong DNS fails before TLS and a broken certificate fails the preflight", async () => {
  let tlsCalls = 0;
  const options = { domain: "bridge.example.com", expectedIp: "1.1.1.1",
    resolve4: async () => ["1.1.1.2"], resolve6: async () => [],
    checkTls: async () => { tlsCalls++; } };
  await assert.rejects(checkDnsAndTls({ ...options, expectedIp: "127.0.0.1" }), /public IPv4/);
  await assert.rejects(checkDnsAndTls({ ...options, expectedIp: "203.0.113.10" }), /public IPv4/);
  await assert.rejects(checkDnsAndTls(options), /DNS must point/);
  assert.equal(tlsCalls, 0);
  await assert.rejects(checkDnsAndTls({ ...options, resolve4: async () => [options.expectedIp],
    checkTls: async () => { throw new Error("HTTPS certificate or connection check failed"); } }), /HTTPS certificate/);
  assert.deepEqual(await checkDnsAndTls({ ...options, resolve4: async () => [options.expectedIp] }),
    { domain: options.domain, expectedIp: options.expectedIp, dns: "pass", tls: "pass" });
  await assert.rejects(checkDnsAndTls({ ...options, resolve4: async () => [options.expectedIp],
    resolve6: async () => ["2001:db8::1"] }), /DNS must point/);
});

test("R0004: a stalled DNS lookup fails before contacting TLS", async () => {
  let tlsCalls = 0;
  const started = Date.now();
  await assert.rejects(checkDnsAndTls({
    domain: "bridge.example.com", expectedIp: "1.1.1.1", dnsTimeoutMs: 20,
    resolve4: () => new Promise(() => {}), resolve6: async () => [],
    checkTls: async () => { tlsCalls++; }
  }), /DNS lookup timed out/);
  assert.equal(tlsCalls, 0);
  assert.ok(Date.now() - started < 1000);
});

import test from "node:test";
import assert from "node:assert/strict";
import { compareBegetOAuthRouteSnapshots } from
  "../scripts/release/inspect-beget-oauth-route-boundary.mjs";
import { BEGET_OAUTH_ROUTE_SHA256 } from
  "../scripts/release/inspect-beget-traefik-route.mjs";

function snapshots() {
  const route = { traefikContainerId: "a".repeat(64),
    fileSha256: BEGET_OAUTH_ROUTE_SHA256, dockerRouters: 9 };
  const host = { traefikContainerId: route.traefikContainerId,
    publicPorts: [80, 443], listening: ["0.0.0.0:443", "127.0.0.1:8789", "172.18.0.1:8791"] };
  const external = { domain: "bridge-oauth.pareshnev.com", expectedIp: "45.12.238.143",
    dns: "pass", tls: "pass" };
  const nat = { traefikContainerId: route.traefikContainerId,
    ipv4Target: "172.18.0.2", ipv4PublicPorts: [80, 443], ipv6Dnat: false,
    loopbackTargets: ["172.18.0.6:5432", "172.18.0.4:5678"] };
  return [[{ ...route }, { ...host, listening: [...host.listening] }, { ...external },
    { ...nat, ipv4PublicPorts: [...nat.ipv4PublicPorts] }],
  [{ ...route }, { ...host, listening: [...host.listening] }, { ...external },
    { ...nat, ipv4PublicPorts: [...nat.ipv4PublicPorts] }]];
}

test("OPS-07: consecutive route and listener snapshots bind to one Traefik container", () => {
  const [first, second] = snapshots();
  const report = compareBegetOAuthRouteSnapshots(first, second);
  assert.equal(report.traefikContainerId, "a".repeat(64));
  assert.equal(report.scope,
    "DNS, TLS, Traefik providers, host listeners and pinned Docker NAT only");
  assert.equal(report.publicIp, "45.12.238.143");
  assert.equal(report.natTarget, "172.18.0.2");
  assert.deepEqual(report.listening, first[1].listening);
});

test("OPS-07: cross-surface identity and changed listener/configuration fail closed", () => {
  for (const mutate of [
    value => { value[0][1].traefikContainerId = "b".repeat(64); },
    value => { value[1][0].traefikContainerId = "b".repeat(64); },
    value => { value[1][0].fileSha256 = "c".repeat(64); },
    value => { value[0][0].fileSha256 = "c".repeat(64); },
    value => { value[1][0].dockerRouters = 10; },
    value => { value[1][1].listening.push("0.0.0.0:8789"); },
    value => { value[0][1].publicPorts = [443]; },
    value => { value[1][2].expectedIp = "45.12.238.144"; },
    value => { value[0][2].tls = "fail"; },
    value => { value[0][3].traefikContainerId = "b".repeat(64); },
    value => { value[1][3].ipv4Target = "172.18.0.9"; },
    value => { value[1][3].loopbackTargets = ["172.18.0.8:5432", "172.18.0.4:5678"]; },
    value => { value[0][3].ipv6Dnat = true; }
  ]) {
    const value = snapshots();
    mutate(value);
    assert.throws(() => compareBegetOAuthRouteSnapshots(...value), /surfaces changed/);
  }
});

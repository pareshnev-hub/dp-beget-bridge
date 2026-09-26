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
  return [[{ ...route }, { ...host, listening: [...host.listening] }],
    [{ ...route }, { ...host, listening: [...host.listening] }]];
}

test("OPS-07: consecutive route and listener snapshots bind to one Traefik container", () => {
  const [first, second] = snapshots();
  const report = compareBegetOAuthRouteSnapshots(first, second);
  assert.equal(report.traefikContainerId, "a".repeat(64));
  assert.equal(report.scope, "Traefik providers and host listeners only");
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
    value => { value[0][1].publicPorts = [443]; }
  ]) {
    const value = snapshots();
    mutate(value);
    assert.throws(() => compareBegetOAuthRouteSnapshots(...value), /surfaces changed/);
  }
});

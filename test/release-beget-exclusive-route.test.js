import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertBegetOAuthRouteExclusive } from
  "../scripts/release/assert-beget-oauth-route-exclusive.mjs";
import { BEGET_OAUTH_ROUTE_SHA256 } from
  "../scripts/release/inspect-beget-traefik-route.mjs";

const BODY = Buffer.from('{"error":{"code":"unauthorized","message":"Invalid access token"}}');
const CHALLENGE = 'Bearer resource_metadata="https://bridge-oauth.pareshnev.com/.well-known/oauth-protected-resource", scope="terminal:read terminal:execute terminal:input terminal:close files:read files:write"';
const SCOPE = "DNS, TLS, Traefik, host listeners, Docker NAT and loaded proxy units only";
function boundary() {
  return { traefikContainerId: "a".repeat(64), fileSha256: BEGET_OAUTH_ROUTE_SHA256,
    publicIp: "45.12.238.143", natTarget: "172.18.0.2",
    proxyTarget: "127.0.0.1:8789", dockerRouters: 10, scope: SCOPE,
    externalTcp: ["0.0.0.0:22", "0.0.0.0:443", "0.0.0.0:80",
      "[::]:22", "[::]:443", "[::]:80"] };
}
function proxy(state) {
  return { socketState: state, serviceState: state,
    socketAddress: "172.18.0.1:8791", destination: "127.0.0.1:8789",
    guardInstalled: false };
}
function options(state, response) {
  let reads = 0;
  const value = { inspect: async () => { reads++; return boundary(); },
    inspectProxy: async () => proxy(state),
    inspectTunnel: async () => ({ state, target: "127.0.0.1:8788/mcp", pid: "1111" }),
    publicRequest: async target => {
      assert.equal(target.hostname, "45.12.238.143");
      assert.equal(target.servername, "bridge-oauth.pareshnev.com");
      assert.equal(target.rejectUnauthorized, true);
      return response;
    },
    legacy: async () => ({ status: 401, hops: ["local", "socket", "public"],
      bodySha256: createHash("sha256").update(BODY).digest("hex") }),
    closed: async () => true };
  return { value, reads: () => reads };
}

test("live OAuth route proves active R0003, closed socket and paused candidate in turn", {
  skip: process.getuid?.() !== 0
}, async () => {
  const cases = [
    ["active", { status: 401, headers: { "www-authenticate": CHALLENGE,
      "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      body: BODY }],
    ["inactive", { status: 502, headers: {}, body: Buffer.alloc(0) }],
    ["active", { status: 503, headers: { "content-type": "application/json",
      "cache-control": "no-store" },
      body: Buffer.from('{"error":{"code":"admission_paused"}}') }]
  ];
  for (const [state, response] of cases) {
    const { value, reads } = options(state, response);
    assert.equal(await assertBegetOAuthRouteExclusive(value), true);
    assert.equal(reads(), 2);
  }
});

test("route check refuses an alternate public port, a changed proxy and a reopened socket", {
  skip: process.getuid?.() !== 0
}, async () => {
  const response = { status: 502, headers: {}, body: Buffer.alloc(0) };
  const changed = [
    input => { input.inspect = async () => ({ ...boundary(),
      externalTcp: [...boundary().externalTcp, "0.0.0.0:9000"] }); },
    input => { input.inspectProxy = async () => ({ ...proxy("inactive"),
      destination: "127.0.0.1:8790" }); },
    input => { let n = 0; input.inspect = async () => ({ ...boundary(),
      dockerRouters: ++n === 1 ? 10 : 11 }); },
    input => { let n = 0; input.inspectProxy = async () => proxy(n++ ? "active" : "inactive"); },
    input => { input.closed = async () => false; },
    input => { input.inspectTunnel = async () => ({ state: "active",
      target: "127.0.0.1:8789/mcp", pid: "1111" }); }
  ];
  for (const mutate of changed) {
    const { value } = options("inactive", response);
    mutate(value);
    await assert.rejects(assertBegetOAuthRouteExclusive(value), /exclusive OAuth route/);
  }
});

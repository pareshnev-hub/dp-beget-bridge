import test from "node:test";
import assert from "node:assert/strict";
import { probeBegetClosedOAuthRoute } from
  "../scripts/release/probe-beget-closed-oauth-route.mjs";

const closed = () => ({ status: 502, headers: { "content-type": "text/plain" },
  body: Buffer.from("Bad Gateway") });

test("OPS-07: a bounded public 502 at the pinned OAuth IP supports ingress closure", async () => {
  assert.equal(await probeBegetClosedOAuthRoute({ request: async target => {
    assert.equal(target.hostname, "45.12.238.143");
    assert.equal(target.servername, "bridge-oauth.pareshnev.com");
    assert.equal(target.rejectUnauthorized, true);
    return closed();
  } }), true);
});

test("OPS-07: a live challenge, redirect, other status or oversized body blocks closure", async () => {
  const cases = [
    { ...closed(), status: 401, headers: { "www-authenticate": "Bearer" } },
    { ...closed(), status: 503 },
    { ...closed(), headers: { location: "https://elsewhere.example/" } },
    { ...closed(), body: Buffer.alloc(4097) },
    { ...closed(), body: "unexpected" }
  ];
  for (const response of cases) {
    await assert.rejects(probeBegetClosedOAuthRoute({ request: async () => response }),
      /did not close/);
  }
  await assert.rejects(probeBegetClosedOAuthRoute({ request: async () => {
    throw new Error("TLS validation failed");
  } }), /TLS validation failed/);
});

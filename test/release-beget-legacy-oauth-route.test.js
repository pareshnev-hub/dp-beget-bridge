import test from "node:test";
import assert from "node:assert/strict";
import { probeBegetLegacyOAuthRoute, validateBegetLegacyOAuthResponses } from
  "../scripts/release/probe-beget-legacy-oauth-route.mjs";

const challenge = 'Bearer resource_metadata="https://bridge-oauth.pareshnev.com/.well-known/oauth-protected-resource", scope="terminal:read terminal:execute terminal:input terminal:close files:read files:write"';
function response() {
  return { status: 401, headers: { "www-authenticate": challenge,
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  body: Buffer.from('{"error":{"code":"unauthorized","message":"Invalid access token"}}') };
}

test("OPS-07: private loopback, dedicated socket and IP-pinned HTTPS agree on OAuth identity", async () => {
  const targets = [];
  const report = await probeBegetLegacyOAuthRoute({ request: async target => {
    targets.push(target);
    return response();
  } });
  assert.deepEqual(targets.map(value => `${value.label}:${value.hostname}:${value.port}`), [
    "local:127.0.0.1:8789", "socket:172.18.0.1:8791", "public:45.12.238.143:443"
  ]);
  assert.equal(targets[2].servername, "bridge-oauth.pareshnev.com");
  assert.equal(targets[2].rejectUnauthorized, true);
  assert.equal(report.status, 401);
  assert.deepEqual(report.hops, ["local", "socket", "public"]);
  assert.equal(report.scope, "R0003 response parity only");
});

test("OPS-07: inconsistent response identity and body fail the read-only route probe", () => {
  for (const change of [
    r => { r[2].status = 302; },
    r => { r[2].headers.location = "https://other.example"; },
    r => { r[2].headers["www-authenticate"] = "Bearer"; },
    r => { r[1].body = Buffer.from('{"error":{"code":"unauthorized","message":"Other"}}'); },
    r => { r[0].body = Buffer.from('{"error":{"code":"admission_paused"}}'); },
    r => { r[0].body = Buffer.alloc(4097); }
  ]) {
    const responses = [response(), response(), response()];
    change(responses);
    assert.throws(() => validateBegetLegacyOAuthResponses(responses), /route:/);
  }
});

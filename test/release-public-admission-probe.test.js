import test from "node:test";
import assert from "node:assert/strict";
import { probePublicOAuthPaused } from "../scripts/release/public-admission-probe.mjs";

const url = "https://bridge-oauth.pareshnev.com/mcp";
function reply(status, body, responseUrl = url) {
  const response = new Response(JSON.stringify(body), { status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  return { status: response.status, headers: response.headers, body: response.body, url: responseUrl };
}

test("public admission probe uses a fixed HTTPS non-health route and accepts gate denial", async () => {
  const result = await probePublicOAuthPaused({ request: async (actual, options) => {
    assert.equal(actual, url);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.ok(options.signal);
    return reply(503, { error: { code: "admission_paused", message: "Bridge update in progress" } });
  } });
  assert.equal(result, true);
});

test("public admission probe rejects a proxy error, unrelated denial or changed hostname", async () => {
  for (const response of [
    reply(502, { error: { code: "admission_paused" } }),
    reply(503, { error: { code: "temporarily_unavailable" } }),
    reply(503, { error: { code: "admission_paused" } }, "https://other.example/mcp")
  ]) {
    await assert.rejects(probePublicOAuthPaused({ request: async () => response }), /not proven|admission gate/);
  }
});

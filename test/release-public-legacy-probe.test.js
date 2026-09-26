import assert from "node:assert/strict";
import { test } from "node:test";
import { probePublicLegacyOAuth } from "../scripts/release/public-legacy-probe.mjs";

const url = "https://bridge-oauth.pareshnev.com/mcp";
function response(status = 401, challenge = 'Bearer resource_metadata="https://bridge-oauth.pareshnev.com/.well-known/oauth-protected-resource", scope="files:read"',
  body = { error: { code: "unauthorized", message: "Invalid access token" } }) {
  const result = new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "www-authenticate": challenge
  } });
  Object.defineProperty(result, "url", { value: url });
  return result;
}
test("fixed public legacy challenge accepts only the expected OAuth response", async () => {
  assert.equal(await probePublicLegacyOAuth({ request: async (target, options) => {
    assert.equal(target, url);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    return response();
  } }), true);
  for (const bad of [response(503), response(401, "Bearer"),
    response(401, 'Bearer resource_metadata="https://other.example/.well-known/oauth-protected-resource"'),
    response(401, 'Bearer resource_metadata="https://bridge-oauth.pareshnev.com/.well-known/oauth-protected-resource"',
      { error: { code: "admission_paused" } })]) {
    await assert.rejects(probePublicLegacyOAuth({ request: async () => bad }));
  }
});
test("public legacy probe rejects oversized and redirected responses", async () => {
  await assert.rejects(probePublicLegacyOAuth({ request: async () => response(401, undefined,
    { error: { code: "unauthorized", padding: "x".repeat(4100) } }) }), /limit/);
  await assert.rejects(probePublicLegacyOAuth({ request: async () => {
    const redirected = response();
    Object.defineProperty(redirected, "url", { value: "https://other.example/mcp" });
    return redirected;
  } }));
});

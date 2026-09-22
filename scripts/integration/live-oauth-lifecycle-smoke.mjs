import assert from "node:assert/strict";
import crypto from "node:crypto";
import { oauthDefaults } from "../../packages/auth/src/oauth-spike.js";

const port = Number.parseInt(process.env.DP_MCP_PORT || "8789", 10);
const origin = `http://127.0.0.1:${port}`;
const issuer = process.env.DP_OAUTH_ISSUER || process.env.DP_PUBLIC_URL;
const resource = process.env.DP_OAUTH_RESOURCE || `${issuer}/mcp`;
const approvalSecret = process.env.DP_OAUTH_STAGING_APPROVAL_SECRET || "";
const scope = (process.env.DP_OAUTH_SCOPES || "files:read").split(",").join(" ");

if (!issuer?.startsWith("https://") || !resource?.startsWith("https://")) {
  throw new Error("OAuth issuer and resource must be configured");
}
if (approvalSecret.length < 32) throw new Error("OAuth approval secret is unavailable");

async function json(response) {
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function registerClient() {
  const { response, body } = await json(await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [oauthDefaults.chatGptRedirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  }));
  assert.equal(response.status, 201, "DCR registration failed");
  assert.match(body.client_id, /^dcr_[A-Za-z0-9_-]+$/);
  return body.client_id;
}

async function issue(clientId, state) {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${origin}/oauth/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: oauthDefaults.chatGptRedirectUri,
    resource,
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  })) authorize.searchParams.set(key, value);
  const page = await fetch(authorize);
  assert.equal(page.status, 200, "Authorization page failed");
  const html = await page.text();
  const transaction = /name="transaction" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  assert.ok(transaction, "Authorization transaction is missing");
  const approval = await fetch(`${origin}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transaction, approval_secret: approvalSecret }),
  });
  assert.equal(approval.status, 303, "Owner approval failed");
  const callback = new URL(approval.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), state);
  const { response, body } = await json(await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code"),
      client_id: clientId,
      redirect_uri: oauthDefaults.chatGptRedirectUri,
      resource,
      code_verifier: verifier,
    }),
  }));
  assert.equal(response.status, 200, "Authorization-code exchange failed");
  assert.match(body.access_token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(body.refresh_token, /^[A-Za-z0-9_-]{43}$/);
  return body;
}

async function refresh(clientId, refreshToken) {
  return json(await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      resource,
    }),
  }));
}

async function protectedStatus(accessToken) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
  });
  await response.arrayBuffer();
  return response.status;
}

const clientId = await registerClient();
const first = await issue(clientId, "dp014-refresh-reuse");
const rotated = await refresh(clientId, first.refresh_token);
assert.equal(rotated.response.status, 200, "Refresh rotation failed");
assert.notEqual(rotated.body.refresh_token, first.refresh_token);
assert.notEqual(await protectedStatus(rotated.body.access_token), 401, "Rotated access token was not accepted");

const reused = await refresh(clientId, first.refresh_token);
assert.equal(reused.response.status, 400, "Reused refresh token was not rejected");
assert.equal(reused.body.error, "invalid_grant");
assert.equal(await protectedStatus(rotated.body.access_token), 401, "Compromised family access remained valid");
const successor = await refresh(clientId, rotated.body.refresh_token);
assert.equal(successor.response.status, 400, "Successor of compromised family remained valid");

const second = await issue(clientId, "dp014-revoke");
assert.notEqual(await protectedStatus(second.access_token), 401, "Fresh access token was not accepted");
const revocation = await fetch(`${origin}/oauth/revoke`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    token: second.refresh_token,
    token_type_hint: "refresh_token",
    client_id: clientId,
  }),
});
assert.equal(revocation.status, 200, "Revocation endpoint failed");
assert.equal(await protectedStatus(second.access_token), 401, "Revoked family access remained valid");

console.log("SUCCESS: DP-014 live refresh rotation, reuse detection and revocation verified");

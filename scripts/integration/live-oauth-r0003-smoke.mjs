import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const localOrigin = process.env.DP_OAUTH_LOCAL_ORIGIN || "http://127.0.0.1:8789";
const publicUrl = process.env.DP_PUBLIC_URL || "";
const resource = process.env.DP_OAUTH_RESOURCE || (publicUrl ? `${publicUrl.replace(/\/$/, "")}/mcp` : "");
const approvalSecret = process.env.DP_OAUTH_STAGING_APPROVAL_SECRET || "";
const scopes = (process.env.DP_OAUTH_SCOPES || "").split(",").map((value) => value.trim()).filter(Boolean);
const requiredScopes = [
  "terminal:read",
  "terminal:execute",
  "terminal:input",
  "terminal:close",
  "files:read",
  "files:write",
];

if (process.getuid?.() !== 0) throw new Error("R0003 OAuth terminal smoke requires root for controlled service restarts");
if (!publicUrl.startsWith("https://") || !resource.startsWith("https://")) {
  throw new Error("DP_PUBLIC_URL and DP_OAUTH_RESOURCE must identify the HTTPS OAuth deployment");
}
if (approvalSecret.length < 32) throw new Error("OAuth owner approval secret is unavailable");
for (const scope of requiredScopes) {
  if (!scopes.includes(scope)) throw new Error(`Required private-beta scope is not configured: ${scope}`);
}

async function expectJson(response, expectedStatus, label) {
  assert.equal(response.status, expectedStatus, `${label} failed with HTTP ${response.status}`);
  return response.json();
}

async function registerClient() {
  return expectJson(await fetch(`${localOrigin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  }), 201, "DCR registration");
}

async function issueToken(clientId, advertisedScope) {
  assert.deepEqual(new Set(advertisedScope.split(/\s+/).filter(Boolean)), new Set(scopes));
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("base64url");
  const authorize = new URL(`${localOrigin}/oauth/authorize`);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
    resource,
    scope: scopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  })) authorize.searchParams.set(name, value);
  const page = await fetch(authorize);
  assert.equal(page.status, 200, "Authorization page failed");
  const html = await page.text();
  assert.match(html, /Execution profile: <strong>Full shell access<\/strong>/);
  assert.match(html, /configured work-account operating-system rights/);
  const transaction = /name="transaction" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  assert.ok(transaction, "Authorization transaction is missing");
  const approval = await fetch(`${localOrigin}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transaction, approval_secret: approvalSecret }),
  });
  assert.equal(approval.status, 303, "Owner approval failed");
  const callback = new URL(approval.headers.get("location"));
  assert.equal(callback.searchParams.get("state"), state);
  return expectJson(await fetch(`${localOrigin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code"),
      client_id: clientId,
      redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
      resource,
      code_verifier: verifier,
    }),
  }), 200, "Authorization-code exchange");
}

async function revoke(clientId, refreshToken) {
  const response = await fetch(`${localOrigin}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: refreshToken,
      token_type_hint: "refresh_token",
      client_id: clientId,
    }),
  });
  assert.equal(response.status, 200, "OAuth revocation failed");
}

async function protectedStatus(accessToken) {
  const response = await fetch(`${localOrigin}/mcp`, {
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

async function runTerminalSmoke(accessToken) {
  const script = fileURLToPath(new URL("./live-mcp-smoke.mjs", import.meta.url));
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      stdio: "inherit",
      env: {
        ...process.env,
        DP_MCP_SMOKE_URL: `${localOrigin}/mcp`,
        DP_MCP_ACCESS_TOKEN: accessToken,
        DP_MCP_SMOKE_RESTART_SYSTEMD: "true",
        DP_MCP_SMOKE_MCP_UNIT: process.env.DP_MCP_SMOKE_MCP_UNIT || "dp-beget-mcp-oauth-spike.service",
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Terminal smoke failed (${signal || `exit ${code}`})`));
    });
  });
}

const registration = await registerClient();
let token;
try {
  token = await issueToken(registration.client_id, registration.scope);
  assert.notEqual(await protectedStatus(token.access_token), 401, "Fresh OAuth access was rejected");
  await runTerminalSmoke(token.access_token);
  await revoke(registration.client_id, token.refresh_token);
  assert.equal(await protectedStatus(token.access_token), 401, "Revoked OAuth access remained valid");
  token = undefined;
} finally {
  if (token?.refresh_token) await revoke(registration.client_id, token.refresh_token).catch(() => {});
}

console.log("SUCCESS: R0003 OAuth terminal restart, reconnect, input, interrupt, close and revoke lifecycle verified");

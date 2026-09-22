import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHttpServer } from "../apps/mcp/src/server.js";
import { DownloadTokenStore } from "../apps/mcp/src/download-tokens.js";
import { ChatGptCimdRegistry, OAuthSpike, oauthDefaults } from "../packages/auth/src/oauth-spike.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const approvalSecret = "owner-staging-secret-that-is-long-enough";

function clientRegistry() {
  return new ChatGptCimdRegistry({
    fetchImpl: async () => new Response(JSON.stringify({
      client_id: oauthDefaults.chatGptClientId,
      redirect_uris: [oauthDefaults.chatGptRedirectUri],
      token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
}

test("DP-012 HTTP flow exposes metadata, challenges with RFC9728, and restricts OAuth tools", async (t) => {
  const config = {
    path: "/mcp",
    publicUrl: "https://bridge.example.test",
    accessToken: "",
    authMode: "oauth",
  };
  const oauth = new OAuthSpike({
    issuer: config.publicUrl,
    resource: `${config.publicUrl}${config.path}`,
    approvalSecret,
    clientRegistry: clientRegistry(),
  });
  const agent = {
    async capabilities() { return { product: "DP Beget Bridge", protocolVersion: "1.0" }; },
    async listFiles(candidate) { return { path: candidate, entries: [] }; },
  };
  const server = createMcpHttpServer({
    config,
    oauth,
    agent,
    downloads: new DownloadTokenStore({ ttlMs: 1000 }),
    logger,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const resourceMetadata = await fetch(`${origin}/.well-known/oauth-protected-resource`);
  assert.equal(resourceMetadata.status, 200);
  assert.deepEqual(await resourceMetadata.json(), oauth.protectedResourceMetadata());

  const authorizationMetadata = await fetch(`${origin}/.well-known/oauth-authorization-server`);
  assert.equal(authorizationMetadata.status, 200);
  const authorizationDocument = await authorizationMetadata.json();
  assert.equal(authorizationDocument.code_challenge_methods_supported[0], "S256");
  assert.deepEqual(authorizationDocument.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.equal(authorizationDocument.revocation_endpoint, `${config.publicUrl}/oauth/revoke`);

  const registration = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [oauthDefaults.chatGptRedirectUri], token_endpoint_auth_method: "none" }),
  });
  assert.equal(registration.status, 201);
  assert.match((await registration.json()).client_id, /^dcr_/);
  const rejectedRegistration = await fetch(`${origin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://attacker.example/callback"] }),
  });
  assert.equal(rejectedRegistration.status, 400);

  const denied = await fetch(`${origin}/mcp`, { method: "POST" });
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("www-authenticate"), /resource_metadata=/);
  assert.match(denied.headers.get("www-authenticate"), /scope="files:read"/);

  const verifier = "v".repeat(64);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${origin}/oauth/authorize`);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: oauthDefaults.chatGptClientId,
    redirect_uri: oauthDefaults.chatGptRedirectUri,
    resource: `${config.publicUrl}${config.path}`,
    scope: "files:read",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "http-state",
  })) authorize.searchParams.set(name, value);
  const page = await fetch(authorize);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Execution profile: <strong>Read-only files<\/strong>/);
  assert.match(html, /cannot modify files or run commands/);
  const transaction = /name="transaction" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
  assert.ok(transaction);

  const approval = await fetch(`${origin}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transaction, approval_secret: approvalSecret }),
  });
  assert.equal(approval.status, 303);
  const callback = new URL(approval.headers.get("location"));
  assert.equal(callback.searchParams.get("iss"), config.publicUrl);

  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code"),
      client_id: oauthDefaults.chatGptClientId,
      redirect_uri: oauthDefaults.chatGptRedirectUri,
      resource: `${config.publicUrl}${config.path}`,
      code_verifier: verifier,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const token = await tokenResponse.json();

  const client = new Client({ name: "dp012-http-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token.access_token}` } },
  });
  await client.connect(transport);
  t.after(() => client.close());
  const tools = await client.listTools();
  const names = tools.tools.map(({ name }) => name).sort();
  assert.deepEqual(names, ["download_file", "get_bridge_status", "list_files"]);
  const listed = await client.callTool({ name: "list_files", arguments: { path: "." } });
  assert.deepEqual(listed.structuredContent, { path: ".", entries: [] });

  const revocation = await fetch(`${origin}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: token.access_token,
      token_type_hint: "access_token",
      client_id: oauthDefaults.chatGptClientId,
    }),
  });
  assert.equal(revocation.status, 200);
  const revoked = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  assert.equal(revoked.status, 401);
});

test("DP-013 full-shell consent clearly discloses operating-system rights", async (t) => {
  const config = {
    path: "/mcp",
    publicUrl: "https://bridge.example.test",
    accessToken: "",
    authMode: "oauth",
  };
  const oauth = new OAuthSpike({
    issuer: config.publicUrl,
    resource: `${config.publicUrl}${config.path}`,
    approvalSecret,
    clientRegistry: clientRegistry(),
    executionProfile: "full-shell",
  });
  const server = createMcpHttpServer({
    config,
    oauth,
    agent: {},
    downloads: new DownloadTokenStore({ ttlMs: 1000 }),
    logger,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const verifier = "v".repeat(64);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${origin}/oauth/authorize`);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: oauthDefaults.chatGptClientId,
    redirect_uri: oauthDefaults.chatGptRedirectUri,
    resource: `${config.publicUrl}${config.path}`,
    scope: "files:read",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "full-shell-disclosure",
  })) authorize.searchParams.set(name, value);
  const page = await fetch(authorize);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Execution profile: <strong>Full shell access<\/strong>/);
  assert.match(html, /configured work-account operating-system rights/);
  assert.match(html, /read, create, modify, move, or delete every file accessible to that account/);
  assert.match(html, /cause irreversible data loss/);
  assert.match(html, /existing sudo or elevation rights/);
  assert.match(html, />Authorize full shell access<\/button>/);
});

test("DP-012 OAuth mode never falls back to the legacy static bearer", async (t) => {
  const config = {
    path: "/mcp",
    publicUrl: "https://bridge.example.test",
    accessToken: "legacy-token-that-must-not-work",
    authMode: "oauth",
  };
  const oauth = new OAuthSpike({
    issuer: config.publicUrl,
    resource: `${config.publicUrl}${config.path}`,
    approvalSecret,
    clientRegistry: clientRegistry(),
  });
  const server = createMcpHttpServer({
    config,
    oauth,
    agent: {},
    downloads: new DownloadTokenStore({ ttlMs: 1000 }),
    logger,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.accessToken}` },
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /resource_metadata=/);
});

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { ChatGptCimdRegistry, OAuthSpike, oauthDefaults } from "../packages/auth/src/oauth-spike.js";

const issuer = "https://bridge.example.test";
const resource = "https://bridge.example.test/mcp";
const approvalSecret = "owner-staging-secret-that-is-long-enough";
const clientDocument = {
  client_id: oauthDefaults.chatGptClientId,
  redirect_uris: [oauthDefaults.chatGptRedirectUri],
  token_endpoint_auth_method: "private_key_jwt",
  token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
};

function registry(document = clientDocument) {
  return new ChatGptCimdRegistry({
    fetchImpl: async () => new Response(JSON.stringify(document), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
}

function verifierAndChallenge() {
  const verifier = "v".repeat(64);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function authorizationParams(overrides = {}) {
  const { challenge } = verifierAndChallenge();
  return new URLSearchParams({
    response_type: "code",
    client_id: oauthDefaults.chatGptClientId,
    redirect_uri: oauthDefaults.chatGptRedirectUri,
    resource,
    scope: "files:read",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    ...overrides,
  });
}

function createOauth(options = {}) {
  return new OAuthSpike({ issuer, resource, approvalSecret, clientRegistry: registry(), ...options });
}

test("DP-012 metadata binds the protected resource to a local authorization server", () => {
  const oauth = createOauth();
  assert.deepEqual(oauth.protectedResourceMetadata(), {
    resource,
    authorization_servers: [issuer],
    scopes_supported: ["files:read"],
  });
  assert.deepEqual(oauth.authorizationServerMetadata(), {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["files:read"],
    client_id_metadata_document_supported: true,
    registration_endpoint: `${issuer}/oauth/register`,
    authorization_response_iss_parameter_supported: true,
  });
  assert.match(oauth.challenge(), /resource_metadata="https:\/\/bridge\.example\.test\/\.well-known\/oauth-protected-resource"/);
});

test("AUTH-01: wrong redirect URI is rejected after CIMD validation", async () => {
  const oauth = createOauth();
  await assert.rejects(
    oauth.beginAuthorization(authorizationParams({ redirect_uri: "https://attacker.example/callback" })),
    { name: "OAuthError", code: "invalid_request" },
  );
});

test("AUTH-02: missing S256 challenge is rejected", async () => {
  const oauth = createOauth();
  const missing = authorizationParams();
  missing.delete("code_challenge");
  await assert.rejects(oauth.beginAuthorization(missing), { name: "OAuthError", code: "invalid_request" });
  await assert.rejects(
    oauth.beginAuthorization(authorizationParams({ code_challenge_method: "plain" })),
    { name: "OAuthError", code: "invalid_request" },
  );
});

test("AUTH-03: wrong resource is rejected before approval", async () => {
  const oauth = createOauth();
  await assert.rejects(
    oauth.beginAuthorization(authorizationParams({ resource: "https://other.example/mcp" })),
    { name: "OAuthError", code: "invalid_target" },
  );
});

test("DP-012 authorization code is one-use, PKCE-bound, and issues an audience-bound token", async () => {
  const oauth = createOauth();
  const transaction = await oauth.beginAuthorization(authorizationParams());
  const redirect = new URL(oauth.approve({ transactionId: transaction.id, approvalSecret }));
  assert.equal(redirect.origin + redirect.pathname, oauthDefaults.chatGptRedirectUri);
  assert.equal(redirect.searchParams.get("state"), "state-123");
  assert.equal(redirect.searchParams.get("iss"), issuer);
  const code = redirect.searchParams.get("code");
  const { verifier } = verifierAndChallenge();
  const exchange = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: oauthDefaults.chatGptClientId,
    redirect_uri: oauthDefaults.chatGptRedirectUri,
    resource,
    code_verifier: verifier,
  });
  const token = oauth.exchange(exchange);
  assert.equal(token.token_type, "Bearer");
  assert.equal(token.scope, "files:read");
  const authorization = oauth.authenticate(`Bearer ${token.access_token}`);
  assert.equal(authorization.kind, "oauth-spike");
  assert.deepEqual([...authorization.scopes], ["files:read"]);
  await assert.throws(() => oauth.exchange(exchange), { name: "OAuthError", code: "invalid_grant" });
});

test("AUTH-02: wrong verifier consumes the authorization code and fails closed", async () => {
  const oauth = createOauth();
  const transaction = await oauth.beginAuthorization(authorizationParams());
  const redirect = new URL(oauth.approve({ transactionId: transaction.id, approvalSecret }));
  const exchange = new URLSearchParams({
    grant_type: "authorization_code",
    code: redirect.searchParams.get("code"),
    client_id: oauthDefaults.chatGptClientId,
    redirect_uri: oauthDefaults.chatGptRedirectUri,
    resource,
    code_verifier: "x".repeat(64),
  });
  assert.throws(() => oauth.exchange(exchange), { name: "OAuthError", code: "invalid_grant" });
  const { verifier } = verifierAndChallenge();
  exchange.set("code_verifier", verifier);
  assert.throws(() => oauth.exchange(exchange), { name: "OAuthError", code: "invalid_grant" });
});

test("owner approval failure consumes the bounded staging transaction", async () => {
  const oauth = createOauth({ maxPendingTransactions: 1 });
  const transaction = await oauth.beginAuthorization(authorizationParams());
  assert.throws(
    () => oauth.approve({ transactionId: transaction.id, approvalSecret: "wrong-secret" }),
    { name: "OAuthError", code: "access_denied" },
  );
  assert.throws(
    () => oauth.approve({ transactionId: transaction.id, approvalSecret }),
    { name: "OAuthError", code: "invalid_request" },
  );
  await oauth.beginAuthorization(authorizationParams({ state: "replacement" }));
  await assert.rejects(
    oauth.beginAuthorization(authorizationParams({ state: "overflow" })),
    { name: "OAuthError", code: "temporarily_unavailable" },
  );
});

test("CIMD registry rejects non-allowlisted client metadata URLs without fetching", async () => {
  let fetched = false;
  const cimd = new ChatGptCimdRegistry({ fetchImpl: async () => { fetched = true; return new Response(); } });
  await assert.rejects(
    cimd.validate("https://attacker.example/client.json", "https://attacker.example/callback"),
    { name: "OAuthError", code: "unauthorized_client" },
  );
  assert.equal(fetched, false);
});

test("CIMD metadata streaming is bounded even without Content-Length", async () => {
  const cimd = new ChatGptCimdRegistry({
    maxBytes: 32,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(24));
        controller.enqueue(new Uint8Array(24));
        controller.close();
      },
    }), { status: 200 }),
  });
  await assert.rejects(
    cimd.validate(oauthDefaults.chatGptClientId, oauthDefaults.chatGptRedirectUri),
    { name: "OAuthError", code: "invalid_client" },
  );
});

test("DCR registers only the fixed ChatGPT callback and survives process restart", async () => {
  const metadata = {
    redirect_uris: [oauthDefaults.chatGptRedirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
  };
  const first = createOauth();
  const registration = first.registerClient(metadata);
  assert.match(registration.client_id, /^dcr_[A-Za-z0-9_-]+$/);
  assert.equal(createOauth().registerClient(metadata).client_id, registration.client_id);
  await assert.rejects(
    first.beginAuthorization(authorizationParams({
      client_id: registration.client_id, redirect_uri: "https://attacker.example/callback",
    })),
    { name: "OAuthError", code: "invalid_client" },
  );
  const restarted = createOauth();
  const transaction = await restarted.beginAuthorization(authorizationParams({ client_id: registration.client_id }));
  const redirect = new URL(restarted.approve({ transactionId: transaction.id, approvalSecret }));
  const { verifier } = verifierAndChallenge();
  const token = restarted.exchange(new URLSearchParams({
    grant_type: "authorization_code", code: redirect.searchParams.get("code"),
    client_id: registration.client_id, redirect_uri: oauthDefaults.chatGptRedirectUri,
    resource, code_verifier: verifier,
  }));
  assert.deepEqual([...restarted.authenticate(`Bearer ${token.access_token}`).scopes], ["files:read"]);
  assert.throws(
    () => first.registerClient({ ...metadata, redirect_uris: ["https://attacker.example/callback"] }),
    { name: "OAuthError", code: "invalid_client_metadata" },
  );
});

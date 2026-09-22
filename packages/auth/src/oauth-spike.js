import crypto from "node:crypto";

const DEFAULT_CHATGPT_CLIENT_ID = "https://chatgpt.com/oauth/client.json";
const DEFAULT_CHATGPT_REDIRECT_URI = "https://chatgpt.com/connector_platform_oauth_redirect";
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

function base64url(buffer) {
  return Buffer.from(buffer).toString("base64url");
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function equalText(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function randomToken() {
  return base64url(crypto.randomBytes(32));
}

function sameStrings(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function oauthError(code, description, status = 400) {
  const error = new Error(description);
  error.name = "OAuthError";
  error.code = code;
  error.status = status;
  return error;
}

function canonicalHttpsUrl(name, value, { allowPath = true } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an absolute HTTPS URL without credentials, query, or fragment`);
  }
  if (!allowPath && url.pathname !== "/") throw new Error(`${name} must not contain a path`);
  return url.href.replace(/\/$/, "");
}

function parseScope(value, supportedScopes) {
  const requested = String(value || "").split(/\s+/).filter(Boolean);
  const scopes = requested.length > 0 ? requested : [...supportedScopes];
  if (scopes.length === 0 || scopes.some((scope) => !supportedScopes.has(scope))) {
    throw oauthError("invalid_scope", "Requested scope is not supported");
  }
  return [...new Set(scopes)];
}

function requireString(params, name) {
  const value = params.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw oauthError("invalid_request", `${name} is required`);
  }
  return value;
}

function assertExact(actual, expected, code, message) {
  if (actual !== expected) throw oauthError(code, message);
}

function metadataPathForIssuer(issuer) {
  const { pathname } = new URL(issuer);
  if (pathname === "/") return "/.well-known/oauth-authorization-server";
  return `/.well-known/oauth-authorization-server${pathname}`;
}

function resourceMetadataPaths(resource) {
  const { pathname } = new URL(resource);
  const paths = new Set(["/.well-known/oauth-protected-resource"]);
  if (pathname !== "/") paths.add(`/.well-known/oauth-protected-resource${pathname}`);
  return paths;
}

async function readBoundedBody(response, maxBytes) {
  const chunks = [];
  let size = 0;
  if (!response.body) return Buffer.alloc(0);
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw oauthError("invalid_client", "OAuth client metadata is too large", 400);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

export class ChatGptCimdRegistry {
  constructor({
    fetchImpl = globalThis.fetch,
    allowedClientIds = [DEFAULT_CHATGPT_CLIENT_ID],
    timeoutMs = 5000,
    maxBytes = 64 * 1024,
    cacheTtlMs = 5 * 60 * 1000,
    now = () => Date.now(),
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.allowedClientIds = new Set(allowedClientIds);
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.cache = new Map();
  }

  async validate(clientId, redirectUri) {
    if (!this.allowedClientIds.has(clientId)) {
      throw oauthError("unauthorized_client", "OAuth client is not allowlisted", 403);
    }
    let clientUrl;
    try {
      clientUrl = new URL(clientId);
    } catch {
      throw oauthError("unauthorized_client", "OAuth client metadata URL is invalid", 403);
    }
    if (clientUrl.protocol !== "https:" || clientUrl.hostname !== "chatgpt.com" || clientUrl.username || clientUrl.password) {
      throw oauthError("unauthorized_client", "OAuth client metadata origin is not allowed", 403);
    }
    let metadata = this.cache.get(clientId);
    if (!metadata || metadata.expiresAt <= this.now()) {
      const signal = AbortSignal.timeout(this.timeoutMs);
      const response = await this.fetchImpl(clientId, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json" },
        signal,
      });
      if (!response.ok) throw oauthError("invalid_client", "OAuth client metadata could not be verified", 400);
      const declaredLength = Number.parseInt(response.headers.get("content-length") || "0", 10);
      if (declaredLength > this.maxBytes) throw oauthError("invalid_client", "OAuth client metadata is too large", 400);
      const bytes = await readBoundedBody(response, this.maxBytes);
      let document;
      try {
        document = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw oauthError("invalid_client", "OAuth client metadata is not valid JSON", 400);
      }
      if (document.client_id !== clientId
        || !Array.isArray(document.redirect_uris)
        || !document.redirect_uris.includes(DEFAULT_CHATGPT_REDIRECT_URI)
        || !document.redirect_uris.every((uri) => typeof uri === "string" && uri.startsWith("https://chatgpt.com/"))
        || !Array.isArray(document.response_types)
        || !document.response_types.includes("code")
        || !Array.isArray(document.grant_types)
        || !document.grant_types.includes("authorization_code")) {
        throw oauthError("invalid_client", "OAuth client metadata failed validation", 400);
      }
      const methods = Array.isArray(document.token_endpoint_auth_methods_supported)
        ? document.token_endpoint_auth_methods_supported
        : [document.token_endpoint_auth_method].filter(Boolean);
      if (!methods.includes("none")) {
        throw oauthError("unauthorized_client", "OAuth client does not support public PKCE exchange", 400);
      }
      metadata = { document, expiresAt: this.now() + this.cacheTtlMs };
      this.cache.set(clientId, metadata);
    }
    if (!metadata.document.redirect_uris.includes(redirectUri)) {
      throw oauthError("invalid_request", "redirect_uri is not registered", 400);
    }
    return metadata.document;
  }
}

export class ChatGptDcrRegistry {
  constructor({ approvalSecret, clientId }) {
    this.clientId = clientId || ("dcr_" + base64url(crypto.createHmac("sha256", approvalSecret)
      .update("DP-012 ChatGPT DCR public client v1").digest()));
  }

  register(document) {
    if (!document || typeof document !== "object" || Array.isArray(document)
      || !Array.isArray(document.redirect_uris)
      || document.redirect_uris.length !== 1
      || document.redirect_uris[0] !== DEFAULT_CHATGPT_REDIRECT_URI
      || (document.token_endpoint_auth_method && document.token_endpoint_auth_method !== "none")
      || (document.grant_types && (!Array.isArray(document.grant_types)
        || !document.grant_types.includes("authorization_code")))
      || (document.response_types && (!Array.isArray(document.response_types)
        || !document.response_types.includes("code")))) {
      throw oauthError("invalid_client_metadata", "Only the ChatGPT public authorization-code client is supported");
    }
    return {
      client_id: this.clientId,
      redirect_uris: [DEFAULT_CHATGPT_REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "files:read",
    };
  }

  validate(clientId, redirectUri) {
    if (clientId !== this.clientId || redirectUri !== DEFAULT_CHATGPT_REDIRECT_URI) {
      throw oauthError("invalid_client", "Registered client or redirect URI is invalid");
    }
  }
}

export class OAuthSpike {
  constructor({
    issuer,
    resource,
    approvalSecret,
    scopes = ["files:read"],
    clientRegistry = new ChatGptCimdRegistry(),
    transactionTtlMs = 5 * 60 * 1000,
    codeTtlMs = 2 * 60 * 1000,
    accessTokenTtlMs = 10 * 60 * 1000,
    grantTtlMs = 24 * 60 * 60 * 1000,
    maxPendingTransactions = 128,
    authStore,
    ownerId,
    executionProfile = "files-read",
    now = () => Date.now(),
  }) {
    this.issuer = canonicalHttpsUrl("issuer", issuer);
    this.resource = canonicalHttpsUrl("resource", resource);
    if (typeof approvalSecret !== "string" || approvalSecret.length < 32) {
      throw new Error("OAuth staging approval secret must contain at least 32 characters");
    }
    this.approvalSecret = approvalSecret;
    this.scopes = new Set(scopes);
    if (this.scopes.size === 0) throw new Error("At least one OAuth scope is required");
    this.clientRegistry = clientRegistry;
    const durableDcrClient = authStore && ownerId
      ? authStore.findActiveClient({
        ownerId,
        redirectUri: DEFAULT_CHATGPT_REDIRECT_URI,
        clientIdPrefix: "dcr_",
      })
      : null;
    this.dcrRegistry = new ChatGptDcrRegistry({
      approvalSecret,
      clientId: durableDcrClient?.clientId,
    });
    this.transactionTtlMs = transactionTtlMs;
    this.codeTtlMs = codeTtlMs;
    this.accessTokenTtlMs = accessTokenTtlMs;
    this.grantTtlMs = grantTtlMs;
    this.maxPendingTransactions = maxPendingTransactions;
    this.authStore = authStore || null;
    this.ownerId = ownerId || null;
    this.executionProfile = executionProfile;
    if (Boolean(this.authStore) !== Boolean(this.ownerId)) {
      throw new Error("authStore and ownerId must be configured together");
    }
    if (!Number.isFinite(this.grantTtlMs) || this.grantTtlMs < 1) {
      throw new Error("OAuth grant TTL must be a positive number");
    }
    this.now = now;
    this.transactions = new Map();
    this.codes = new Map();
    this.tokens = new Map();
    this.authorizationMetadataPath = metadataPathForIssuer(this.issuer);
    this.protectedResourceMetadataPaths = resourceMetadataPaths(this.resource);
  }

  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: [...this.scopes],
    };
  }

  authorizationServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [...this.scopes],
      client_id_metadata_document_supported: true,
      registration_endpoint: `${this.issuer}/oauth/register`,
      authorization_response_iss_parameter_supported: true,
    };
  }

  registerClient(document) {
    const registration = this.dcrRegistry.register(document);
    this.persistClient(registration.client_id, registration.redirect_uris[0]);
    return registration;
  }

  persistClient(clientId, redirectUri) {
    if (!this.authStore) return;
    try {
      this.authStore.registerClient({
        clientId,
        ownerId: this.ownerId,
        redirectUri,
        createdAt: new Date(this.now()).toISOString(),
      });
    } catch {
      throw oauthError("temporarily_unavailable", "OAuth client state could not be persisted", 503);
    }
  }

  challenge(scope = [...this.scopes].join(" ")) {
    const metadataUrl = `${new URL(this.resource).origin}/.well-known/oauth-protected-resource`;
    return `Bearer resource_metadata="${metadataUrl}", scope="${scope}"`;
  }

  cleanup() {
    const now = this.now();
    for (const [key, value] of this.transactions) if (value.expiresAt <= now) this.transactions.delete(key);
    for (const [key, value] of this.codes) if (value.expiresAt <= now) this.codes.delete(key);
    for (const [key, value] of this.tokens) if (value.expiresAt <= now) this.tokens.delete(key);
  }

  async beginAuthorization(params) {
    this.cleanup();
    assertExact(requireString(params, "response_type"), "code", "unsupported_response_type", "Only response_type=code is supported");
    const clientId = requireString(params, "client_id");
    const redirectUri = requireString(params, "redirect_uri");
    const resource = requireString(params, "resource");
    assertExact(resource, this.resource, "invalid_target", "resource does not match this MCP server");
    const codeChallenge = requireString(params, "code_challenge");
    assertExact(requireString(params, "code_challenge_method"), "S256", "invalid_request", "PKCE S256 is required");
    if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
      throw oauthError("invalid_request", "code_challenge is not a valid S256 challenge");
    }
    if (clientId.startsWith("dcr_")) this.dcrRegistry.validate(clientId, redirectUri);
    else await this.clientRegistry.validate(clientId, redirectUri);
    this.persistClient(clientId, redirectUri);
    const scopes = parseScope(params.get("scope"), this.scopes);
    if (this.transactions.size >= this.maxPendingTransactions) {
      throw oauthError("temporarily_unavailable", "Too many pending authorization transactions", 503);
    }
    const id = randomToken();
    this.transactions.set(digest(id), {
      clientId,
      redirectUri,
      resource,
      codeChallenge,
      scopes,
      state: params.get("state") || "",
      expiresAt: this.now() + this.transactionTtlMs,
    });
    return { id, clientId, resource, scopes, executionProfile: this.executionProfile };
  }

  approve({ transactionId, approvalSecret }) {
    this.cleanup();
    const key = digest(transactionId || "");
    const transaction = this.transactions.get(key);
    if (!transaction) throw oauthError("invalid_request", "Authorization transaction is invalid or expired", 400);
    this.transactions.delete(key);
    if (!equalText(approvalSecret || "", this.approvalSecret)) {
      throw oauthError("access_denied", "Owner approval was not accepted", 403);
    }
    const approvedAt = this.now();
    let durableGrant = null;
    if (this.authStore) {
      try {
        durableGrant = this.authStore.createGrant({
          ownerId: this.ownerId,
          clientId: transaction.clientId,
          resource: transaction.resource,
          scopes: transaction.scopes,
          executionProfile: this.executionProfile,
          grantedAt: new Date(approvedAt).toISOString(),
          expiresAt: new Date(approvedAt + this.grantTtlMs).toISOString(),
        });
      } catch {
        throw oauthError("temporarily_unavailable", "Authorization grant could not be persisted", 503);
      }
    }
    const code = randomToken();
    this.codes.set(digest(code), {
      ...transaction,
      grantId: durableGrant?.id || null,
      ownerId: durableGrant?.ownerId || null,
      executionProfile: durableGrant?.executionProfile || null,
      expiresAt: approvedAt + this.codeTtlMs,
    });
    const redirect = new URL(transaction.redirectUri);
    redirect.searchParams.set("code", code);
    if (transaction.state) redirect.searchParams.set("state", transaction.state);
    redirect.searchParams.set("iss", this.issuer);
    return redirect.href;
  }

  exchange(params, { authorizationHeader } = {}) {
    this.cleanup();
    if (authorizationHeader) throw oauthError("invalid_client", "Token endpoint client authentication is not supported", 401);
    assertExact(requireString(params, "grant_type"), "authorization_code", "unsupported_grant_type", "Only authorization_code is supported");
    const code = requireString(params, "code");
    const key = digest(code);
    const grant = this.codes.get(key);
    if (!grant) throw oauthError("invalid_grant", "Authorization code is invalid or expired");
    this.codes.delete(key);
    assertExact(requireString(params, "client_id"), grant.clientId, "invalid_grant", "client_id does not match authorization code");
    assertExact(requireString(params, "redirect_uri"), grant.redirectUri, "invalid_grant", "redirect_uri does not match authorization code");
    assertExact(requireString(params, "resource"), grant.resource, "invalid_target", "resource does not match authorization code");
    const verifier = requireString(params, "code_verifier");
    if (!PKCE_VERIFIER.test(verifier)) throw oauthError("invalid_grant", "PKCE code_verifier is invalid");
    const calculated = base64url(crypto.createHash("sha256").update(verifier).digest());
    if (!equalText(calculated, grant.codeChallenge)) throw oauthError("invalid_grant", "PKCE verification failed");
    let durableGrant = null;
    if (this.authStore) {
      try {
        durableGrant = this.authStore.getGrant(grant.grantId, { now: new Date(this.now()).toISOString() });
      } catch {
        throw oauthError("temporarily_unavailable", "Authorization grant state is unavailable", 503);
      }
      if (!durableGrant
        || durableGrant.status !== "ACTIVE"
        || durableGrant.ownerId !== this.ownerId
        || durableGrant.clientId !== grant.clientId
        || durableGrant.resource !== grant.resource
        || !sameStrings(durableGrant.scopes, grant.scopes)) {
        throw oauthError("invalid_grant", "Authorization grant is inactive or does not match the authorization code");
      }
    }
    const issuedAt = this.now();
    const expiresAt = durableGrant
      ? Math.min(issuedAt + this.accessTokenTtlMs, Date.parse(durableGrant.expiresAt))
      : issuedAt + this.accessTokenTtlMs;
    const token = randomToken();
    this.tokens.set(digest(token), {
      clientId: grant.clientId,
      resource: grant.resource,
      scopes: grant.scopes,
      grantId: durableGrant?.id || null,
      ownerId: durableGrant?.ownerId || null,
      executionProfile: durableGrant?.executionProfile || null,
      grantExpiresAt: durableGrant?.expiresAt || null,
      expiresAt,
    });
    return {
      access_token: token,
      token_type: "Bearer",
      expires_in: Math.floor((expiresAt - issuedAt) / 1000),
      scope: grant.scopes.join(" "),
    };
  }

  authenticate(authorizationHeader) {
    this.cleanup();
    const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorizationHeader || "");
    if (!match) return null;
    const record = this.tokens.get(digest(match[1]));
    if (!record || record.resource !== this.resource || record.expiresAt <= this.now()) return null;
    if (this.authStore) {
      let grant;
      try {
        grant = this.authStore.getGrant(record.grantId, { now: new Date(this.now()).toISOString() });
      } catch {
        return null;
      }
      if (!grant
        || grant.status !== "ACTIVE"
        || grant.ownerId !== record.ownerId
        || grant.clientId !== record.clientId
        || grant.resource !== record.resource
        || grant.executionProfile !== record.executionProfile
        || !sameStrings(grant.scopes, record.scopes)) return null;
    }
    return {
      kind: "oauth-spike",
      clientId: record.clientId,
      scopes: new Set(record.scopes),
      ownerId: record.ownerId,
      grantId: record.grantId,
      executionProfile: record.executionProfile,
      grantExpiresAt: record.grantExpiresAt,
    };
  }
}

export const oauthDefaults = Object.freeze({
  chatGptClientId: DEFAULT_CHATGPT_CLIENT_ID,
  chatGptRedirectUri: DEFAULT_CHATGPT_REDIRECT_URI,
});

export function isOAuthError(error) {
  return error?.name === "OAuthError" && typeof error.code === "string";
}

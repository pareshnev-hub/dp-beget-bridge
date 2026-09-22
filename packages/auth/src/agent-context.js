import crypto from "node:crypto";

export const AGENT_CONTEXT_HEADER = "x-dp-authorization-context";
const OWNER_ID = /^[a-zA-Z0-9_-]{1,96}$/;
const GRANT_ID = /^[a-zA-Z0-9_-]{8,128}$/;
const SCOPE = /^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/;
const PROFILE = /^[a-z][a-z0-9-]{1,63}$/;

function contextError(code, message, status = 401) {
  const error = new Error(message);
  error.name = "AgentContextError";
  error.code = code;
  error.status = status;
  return error;
}

function signature(secret, encoded) {
  return crypto.createHmac("sha256", secret)
    .update("DP-013 agent context v1\0")
    .update(encoded)
    .digest("base64url");
}

function safeEqual(left, right) {
  const a = Buffer.from(left || "");
  const b = Buffer.from(right || "");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validateSecret(secret) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw contextError("agent_context_unavailable", "Agent context signing is not configured", 503);
  }
}

function validatePayload(payload) {
  if (!payload || payload.v !== 1
    || !OWNER_ID.test(payload.sub || "")
    || !GRANT_ID.test(payload.grt || "")
    || !Array.isArray(payload.scp)
    || payload.scp.length === 0
    || payload.scp.some((scope) => !SCOPE.test(scope))
    || !PROFILE.test(payload.prf || "")
    || typeof payload.mth !== "string"
    || typeof payload.pth !== "string"
    || !payload.pth.startsWith("/")
    || !Number.isInteger(payload.iat)
    || !Number.isInteger(payload.exp)
    || typeof payload.jti !== "string"
    || payload.jti.length < 16) {
    throw contextError("invalid_agent_context", "Agent authorization context is invalid");
  }
}

export function createAgentContext({
  secret,
  authorization,
  method,
  path,
  now = Date.now(),
  ttlMs = 15_000,
}) {
  validateSecret(secret);
  if (!Number.isFinite(ttlMs) || ttlMs < 1 || ttlMs > 30_000) {
    throw contextError("invalid_agent_context", "Agent context TTL is invalid", 500);
  }
  const issuedAt = Math.floor(now / 1000);
  const payload = {
    v: 1,
    sub: authorization?.ownerId,
    grt: authorization?.grantId,
    scp: [...(authorization?.scopes || [])].sort(),
    prf: authorization?.executionProfile,
    mth: String(method || "GET").toUpperCase(),
    pth: path,
    iat: issuedAt,
    exp: Math.ceil((now + ttlMs) / 1000),
    jti: crypto.randomUUID(),
  };
  validatePayload(payload);
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${signature(secret, encoded)}`;
}

export function verifyAgentContext({
  secret,
  value,
  method,
  path,
  now = Date.now(),
  clockSkewMs = 5_000,
}) {
  validateSecret(secret);
  if (typeof value !== "string" || value.length > 4096) {
    throw contextError("invalid_agent_context", "Agent authorization context is missing or invalid");
  }
  const parts = value.split(".");
  if (parts.length !== 2 || !safeEqual(signature(secret, parts[0]), parts[1])) {
    throw contextError("invalid_agent_context", "Agent authorization context signature is invalid");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    throw contextError("invalid_agent_context", "Agent authorization context is invalid");
  }
  validatePayload(payload);
  const nowSeconds = Math.floor(now / 1000);
  const skewSeconds = Math.ceil(clockSkewMs / 1000);
  if (payload.iat > nowSeconds + skewSeconds
    || payload.exp <= nowSeconds
    || payload.exp - payload.iat > 35) {
    throw contextError("expired_agent_context", "Agent authorization context has expired");
  }
  if (payload.mth !== String(method || "GET").toUpperCase() || payload.pth !== path) {
    throw contextError("agent_context_mismatch", "Agent authorization context does not match this request");
  }
  return {
    kind: "oauth",
    ownerId: payload.sub,
    grantId: payload.grt,
    scopes: new Set(payload.scp),
    executionProfile: payload.prf,
    contextId: payload.jti,
  };
}

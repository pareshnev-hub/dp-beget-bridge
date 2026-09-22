import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const AUTH_SCHEMA_VERSION = 2;
const OWNER_ID = /^[a-zA-Z0-9_-]{1,96}$/;
const OPAQUE_CLIENT_ID = /^[a-zA-Z0-9._~-]{8,256}$/;
const GRANT_ID = /^[a-zA-Z0-9_-]{8,128}$/;
const TOKEN_FAMILY_ID = /^[a-zA-Z0-9_-]{8,128}$/;
const REFRESH_TOKEN = /^[A-Za-z0-9_-]{43,128}$/;
const SCOPE = /^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/;

function authError(code, message, status = 400) {
  const error = new Error(message);
  error.name = "AuthStoreError";
  error.code = code;
  error.status = status;
  return error;
}

function isoTime(name, value) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw authError("invalid_auth_record", `${name} must be an ISO timestamp`);
  return { value: new Date(milliseconds).toISOString(), milliseconds };
}

function hashSecret(secret) {
  return crypto.createHash("sha256").update("DP-013 owner bootstrap v1\0").update(secret).digest("hex");
}

function hashRefreshToken(token) {
  if (!REFRESH_TOKEN.test(token || "")) throw authError("invalid_refresh_token", "Refresh token is invalid");
  return crypto.createHash("sha256").update("DP-014 refresh token v1\0").update(token).digest("hex");
}

function equalDigest(actual, expected) {
  const left = Buffer.from(actual || "", "hex");
  const right = Buffer.from(expected || "", "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function exactHttpsUrl(name, value) {
  let url;
  try { url = new URL(value); } catch { throw authError("invalid_auth_record", `${name} must be an HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw authError("invalid_auth_record", `${name} must be an HTTPS URL without credentials, query or fragment`);
  }
  return url.href;
}

function clientIdentifier(value) {
  if (OPAQUE_CLIENT_ID.test(value || "")) return value;
  try {
    return exactHttpsUrl("clientId", value);
  } catch {
    throw authError("invalid_client", "OAuth client ID is invalid");
  }
}

function ownerFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    bootstrapExpiresAt: row.bootstrap_expires_at,
    bootstrapConsumedAt: row.bootstrap_consumed_at,
    status: row.status,
  };
}

function clientFromRow(row) {
  if (!row) return null;
  return {
    clientId: row.client_id,
    ownerId: row.owner_id,
    redirectUri: row.redirect_uri,
    createdAt: row.created_at,
    status: row.status,
  };
}

function grantFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    clientId: row.client_id,
    resource: row.resource,
    scopes: JSON.parse(row.scopes_json),
    executionProfile: row.execution_profile,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    status: row.status,
  };
}

function tokenFamilyFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    grantId: row.grant_id,
    ownerId: row.owner_id,
    clientId: row.client_id,
    resource: row.resource,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status,
    revokedAt: row.revoked_at,
    revokeReason: row.revoke_reason,
    currentGeneration: row.current_generation,
  };
}

export class AuthStore {
  constructor(dataDir, {
    supportedScopes = [
      "terminal:read", "terminal:execute", "terminal:input", "terminal:close",
      "files:read", "files:write", "files:delete",
    ],
  } = {}) {
    this.dataDir = dataDir;
    this.databasePath = path.join(dataDir, "auth.sqlite");
    this.migrationMarkerPath = path.join(dataDir, "auth.sqlite.migrating");
    this.supportedScopes = new Set(supportedScopes);
    this.db = null;
  }

  async init() {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.dataDir, 0o700);
    await this.recoverInterruptedMigration();
    const existed = await fs.stat(this.databasePath).then((entry) => entry.size > 0).catch(() => false);
    this.db = new DatabaseSync(this.databasePath);
    await fs.chmod(this.databasePath, 0o600);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    const currentVersion = Number(this.db.prepare("PRAGMA user_version").get().user_version);
    if (currentVersion > AUTH_SCHEMA_VERSION) {
      this.close();
      throw authError(
        "auth_schema_incompatible",
        `Auth schema ${currentVersion} is newer than supported schema ${AUTH_SCHEMA_VERSION}`,
        503,
      );
    }
    if (currentVersion < AUTH_SCHEMA_VERSION) {
      try {
        await this.migrate(currentVersion, existed);
      } catch (error) {
        this.close();
        throw error;
      }
    }
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  async recoverInterruptedMigration() {
    let marker;
    try {
      marker = JSON.parse(await fs.readFile(this.migrationMarkerPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw authError("auth_migration_recovery_failed", "Auth migration marker is invalid", 503);
    }

    const expectedBackupPath = Number.isInteger(marker.fromVersion)
      ? path.join(this.dataDir, `auth.sqlite.backup-v${marker.fromVersion}`)
      : null;
    if (
      marker.targetVersion !== AUTH_SCHEMA_VERSION
      || (marker.backupPath !== null && marker.backupPath !== expectedBackupPath)
    ) {
      throw authError("auth_migration_recovery_failed", "Auth migration marker is not trusted", 503);
    }

    let completed = false;
    try {
      const candidate = new DatabaseSync(this.databasePath);
      const version = Number(candidate.prepare("PRAGMA user_version").get().user_version);
      const integrity = candidate.prepare("PRAGMA integrity_check").get().integrity_check;
      candidate.close();
      completed = version === marker.targetVersion && integrity === "ok";
    } catch {
      completed = false;
    }

    if (!completed) {
      if (marker.backupPath) await fs.copyFile(marker.backupPath, this.databasePath);
      else await fs.rm(this.databasePath, { force: true });
    }
    await fs.rm(this.migrationMarkerPath, { force: true });
  }

  async migrate(fromVersion, existed) {
    const backupPath = existed ? path.join(this.dataDir, `auth.sqlite.backup-v${fromVersion}`) : null;
    if (backupPath) await fs.copyFile(this.databasePath, backupPath);
    await fs.writeFile(this.migrationMarkerPath, `${JSON.stringify({
      fromVersion,
      targetVersion: AUTH_SCHEMA_VERSION,
      backupPath,
    })}\n`, { mode: 0o600 });

    try {
      this.db.exec("BEGIN IMMEDIATE");
      if (fromVersion < 1) {
        this.db.exec(`
          CREATE TABLE owners (
            id TEXT PRIMARY KEY,
            singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1),
            created_at TEXT NOT NULL,
            bootstrap_digest TEXT NOT NULL,
            bootstrap_expires_at TEXT NOT NULL,
            bootstrap_consumed_at TEXT,
            status TEXT NOT NULL CHECK (status IN ('ACTIVE','DISABLED'))
          ) STRICT;
          CREATE TABLE oauth_clients (
            client_id TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL REFERENCES owners(id),
            redirect_uri TEXT NOT NULL,
            created_at TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('ACTIVE','DISABLED'))
          ) STRICT;
          CREATE TABLE authorization_grants (
            id TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL REFERENCES owners(id),
            client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
            resource TEXT NOT NULL,
            scopes_json TEXT NOT NULL,
            execution_profile TEXT NOT NULL,
            granted_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('ACTIVE','EXPIRED','REVOKED'))
          ) STRICT;
          CREATE INDEX authorization_grants_lookup
            ON authorization_grants(owner_id, client_id, status, expires_at);
        `);
      }
      if (fromVersion < 2) {
        this.db.exec(`
          CREATE TABLE oauth_token_families (
            id TEXT PRIMARY KEY,
            grant_id TEXT NOT NULL REFERENCES authorization_grants(id),
            owner_id TEXT NOT NULL REFERENCES owners(id),
            client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
            resource TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('ACTIVE','EXPIRED','REVOKED','COMPROMISED','RESET')),
            revoked_at TEXT,
            revoke_reason TEXT,
            current_generation INTEGER NOT NULL CHECK (current_generation >= 0)
          ) STRICT;
          CREATE INDEX oauth_token_families_lookup
            ON oauth_token_families(owner_id, client_id, grant_id, status, expires_at);
          CREATE TABLE oauth_refresh_tokens (
            digest TEXT PRIMARY KEY,
            family_id TEXT NOT NULL REFERENCES oauth_token_families(id),
            generation INTEGER NOT NULL CHECK (generation >= 0),
            issued_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            consumed_at TEXT,
            status TEXT NOT NULL CHECK (status IN ('ACTIVE','CONSUMED','REVOKED')),
            UNIQUE(family_id, generation)
          ) STRICT;
          CREATE INDEX oauth_refresh_tokens_family
            ON oauth_refresh_tokens(family_id, generation, status);
        `);
      }
      this.db.exec(`PRAGMA user_version = ${AUTH_SCHEMA_VERSION}; COMMIT;`);
      await fs.rm(this.migrationMarkerPath, { force: true });
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw authError("auth_migration_failed", "Local auth migration failed", 503);
    }
  }

  createOwnerBootstrap({ ownerId, secret, createdAt = new Date().toISOString(), expiresAt }) {
    if (!OWNER_ID.test(ownerId || "")) throw authError("invalid_owner", "Owner ID is invalid");
    if (typeof secret !== "string" || secret.length < 32) {
      throw authError("invalid_bootstrap", "Owner bootstrap secret must contain at least 32 characters");
    }
    const created = isoTime("createdAt", createdAt);
    const expires = isoTime("expiresAt", expiresAt);
    if (expires.milliseconds <= created.milliseconds) {
      throw authError("invalid_bootstrap", "Owner bootstrap expiry must be after creation");
    }
    try {
      this.db.prepare(`
        INSERT INTO owners (
          id, singleton, created_at, bootstrap_digest, bootstrap_expires_at,
          bootstrap_consumed_at, status
        ) VALUES (?, 1, ?, ?, ?, NULL, 'ACTIVE')
      `).run(ownerId, created.value, hashSecret(secret), expires.value);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        throw authError("owner_already_exists", "This Direct installation already has an owner", 409);
      }
      throw error;
    }
    return this.getOwner(ownerId);
  }

  consumeOwnerBootstrap({ secret, now = new Date().toISOString() }) {
    const current = isoTime("now", now);
    const row = this.db.prepare(`
      SELECT * FROM owners
      WHERE singleton = 1 AND status = 'ACTIVE' AND bootstrap_consumed_at IS NULL
    `).get();
    if (!row) throw authError("bootstrap_unavailable", "Owner bootstrap is unavailable", 409);
    if (Date.parse(row.bootstrap_expires_at) <= current.milliseconds) {
      throw authError("bootstrap_expired", "Owner bootstrap has expired", 410);
    }
    if (typeof secret !== "string" || !equalDigest(hashSecret(secret), row.bootstrap_digest)) {
      throw authError("bootstrap_denied", "Owner bootstrap proof was not accepted", 403);
    }
    const result = this.db.prepare(`
      UPDATE owners SET bootstrap_consumed_at = ?
      WHERE id = ? AND bootstrap_consumed_at IS NULL AND status = 'ACTIVE'
    `).run(current.value, row.id);
    if (result.changes !== 1) throw authError("bootstrap_unavailable", "Owner bootstrap is unavailable", 409);
    return this.getOwner(row.id);
  }

  getOwner(ownerId) {
    return ownerFromRow(this.db.prepare("SELECT * FROM owners WHERE id = ?").get(ownerId));
  }

  registerClient({
    clientId, ownerId, redirectUri, createdAt = new Date().toISOString(),
  }) {
    const normalizedClientId = clientIdentifier(clientId);
    const owner = this.getOwner(ownerId);
    if (!owner || owner.status !== "ACTIVE" || !owner.bootstrapConsumedAt) {
      throw authError("owner_not_bootstrapped", "Owner bootstrap must be completed first", 403);
    }
    const created = isoTime("createdAt", createdAt).value;
    const callback = exactHttpsUrl("redirectUri", redirectUri);
    try {
      this.db.prepare(`
        INSERT INTO oauth_clients (client_id, owner_id, redirect_uri, created_at, status)
        VALUES (?, ?, ?, ?, 'ACTIVE')
      `).run(normalizedClientId, ownerId, callback, created);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) {
        const existing = this.getClient(normalizedClientId);
        if (existing?.ownerId === ownerId && existing.redirectUri === callback) {
          if (existing.status === "ACTIVE") return existing;
          const result = this.db.prepare(`
            UPDATE oauth_clients SET status = 'ACTIVE', created_at = ?
            WHERE client_id = ? AND owner_id = ? AND redirect_uri = ? AND status = 'DISABLED'
          `).run(created, normalizedClientId, ownerId, callback);
          if (result.changes === 1) return this.getClient(normalizedClientId);
        }
        throw authError("client_conflict", "OAuth client registration conflicts with existing state", 409);
      }
      throw error;
    }
    return this.getClient(normalizedClientId);
  }

  getClient(clientId) {
    return clientFromRow(this.db.prepare("SELECT * FROM oauth_clients WHERE client_id = ?").get(clientId));
  }

  findActiveClient({ ownerId, redirectUri, clientIdPrefix = "" }) {
    const callback = exactHttpsUrl("redirectUri", redirectUri);
    const rows = this.db.prepare(`
      SELECT * FROM oauth_clients
      WHERE owner_id = ? AND redirect_uri = ? AND status = 'ACTIVE'
      ORDER BY created_at, client_id
    `).all(ownerId, callback);
    const row = rows.find((candidate) => candidate.client_id.startsWith(clientIdPrefix));
    return clientFromRow(row);
  }

  createGrant({
    id = crypto.randomUUID(),
    ownerId,
    clientId,
    resource,
    scopes,
    executionProfile = "files-read",
    grantedAt = new Date().toISOString(),
    expiresAt,
  }) {
    if (!GRANT_ID.test(id || "")) throw authError("invalid_grant", "Grant ID is invalid");
    const client = this.getClient(clientId);
    if (!client || client.status !== "ACTIVE" || client.ownerId !== ownerId) {
      throw authError("invalid_client", "OAuth client is not active for this owner", 403);
    }
    if (!Array.isArray(scopes) || scopes.length === 0) throw authError("invalid_scope", "At least one scope is required");
    const normalizedScopes = [...new Set(scopes)].sort();
    if (normalizedScopes.some((scope) => !SCOPE.test(scope) || !this.supportedScopes.has(scope))) {
      throw authError("invalid_scope", "Grant includes an unsupported scope");
    }
    const granted = isoTime("grantedAt", grantedAt);
    const expires = isoTime("expiresAt", expiresAt);
    if (expires.milliseconds <= granted.milliseconds) {
      throw authError("invalid_grant", "Grant expiry must be after grant time");
    }
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(executionProfile || "")) {
      throw authError("invalid_grant", "Execution profile is invalid");
    }
    this.db.prepare(`
      INSERT INTO authorization_grants (
        id, owner_id, client_id, resource, scopes_json,
        execution_profile, granted_at, expires_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
    `).run(
      id,
      ownerId,
      clientId,
      exactHttpsUrl("resource", resource),
      JSON.stringify(normalizedScopes),
      executionProfile,
      granted.value,
      expires.value,
    );
    return this.getGrant(id, { now: granted.value });
  }

  getGrant(id, { now = new Date().toISOString() } = {}) {
    const current = isoTime("now", now);
    let row = this.db.prepare("SELECT * FROM authorization_grants WHERE id = ?").get(id);
    if (!row) return null;
    if (row.status === "ACTIVE" && Date.parse(row.expires_at) <= current.milliseconds) {
      this.db.prepare(`
        UPDATE authorization_grants SET status = 'EXPIRED'
        WHERE id = ? AND status = 'ACTIVE'
      `).run(id);
      row = this.db.prepare("SELECT * FROM authorization_grants WHERE id = ?").get(id);
    }
    return grantFromRow(row);
  }

  createTokenFamily({
    id = crypto.randomUUID(),
    grantId,
    ownerId,
    clientId,
    resource,
    refreshToken,
    createdAt = new Date().toISOString(),
    expiresAt,
  }) {
    if (!TOKEN_FAMILY_ID.test(id || "")) throw authError("invalid_token_family", "Token family ID is invalid");
    const created = isoTime("createdAt", createdAt);
    const expires = isoTime("expiresAt", expiresAt);
    const normalizedResource = exactHttpsUrl("resource", resource);
    const refreshDigest = hashRefreshToken(refreshToken);
    const grant = this.getGrant(grantId, { now: created.value });
    if (!grant || grant.status !== "ACTIVE"
      || grant.ownerId !== ownerId || grant.clientId !== clientId || grant.resource !== normalizedResource) {
      throw authError("invalid_grant", "Token family grant is inactive or does not match");
    }
    if (expires.milliseconds <= created.milliseconds || expires.milliseconds > Date.parse(grant.expiresAt)) {
      throw authError("invalid_token_family", "Token family expiry must be after creation and within grant expiry");
    }
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db.prepare(`
        INSERT INTO oauth_token_families (
          id, grant_id, owner_id, client_id, resource, created_at, expires_at,
          status, revoked_at, revoke_reason, current_generation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, NULL, 0)
      `).run(id, grantId, ownerId, clientId, normalizedResource, created.value, expires.value);
      this.db.prepare(`
        INSERT INTO oauth_refresh_tokens (
          digest, family_id, generation, issued_at, expires_at, consumed_at, status
        ) VALUES (?, ?, 0, ?, ?, NULL, 'ACTIVE')
      `).run(refreshDigest, id, created.value, expires.value);
      this.db.exec("COMMIT");
    } catch {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw authError("auth_storage_failure", "Token family could not be persisted", 503);
    }
    return this.getTokenFamily(id, { now: created.value });
  }

  getTokenFamily(id, { now = new Date().toISOString() } = {}) {
    const current = isoTime("now", now);
    let row = this.db.prepare("SELECT * FROM oauth_token_families WHERE id = ?").get(id);
    if (!row) return null;
    if (row.status === "ACTIVE" && Date.parse(row.expires_at) <= current.milliseconds) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        this.db.prepare(`
          UPDATE oauth_token_families
          SET status = 'EXPIRED', revoked_at = ?, revoke_reason = 'expired'
          WHERE id = ? AND status = 'ACTIVE'
        `).run(current.value, id);
        this.db.prepare(`
          UPDATE oauth_refresh_tokens SET status = 'REVOKED'
          WHERE family_id = ? AND status = 'ACTIVE'
        `).run(id);
        this.db.exec("COMMIT");
      } catch {
        try { this.db.exec("ROLLBACK"); } catch {}
        throw authError("auth_storage_failure", "Token family expiry could not be persisted", 503);
      }
      row = this.db.prepare("SELECT * FROM oauth_token_families WHERE id = ?").get(id);
    }
    return tokenFamilyFromRow(row);
  }

  rotateRefreshToken({
    refreshToken,
    nextRefreshToken,
    clientId,
    resource,
    now = new Date().toISOString(),
  }) {
    const current = isoTime("now", now);
    const digest = hashRefreshToken(refreshToken);
    const nextDigest = hashRefreshToken(nextRefreshToken);
    if (digest === nextDigest) throw authError("invalid_refresh_token", "Refresh rotation must replace the token");
    const normalizedClientId = clientIdentifier(clientId);
    const normalizedResource = exactHttpsUrl("resource", resource);
    let row;
    let failure = null;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      row = this.db.prepare(`
        SELECT tf.*, rt.generation AS token_generation, rt.status AS token_status,
          rt.expires_at AS token_expires_at, g.status AS grant_status,
          g.expires_at AS grant_expires_at
        FROM oauth_refresh_tokens rt
        JOIN oauth_token_families tf ON tf.id = rt.family_id
        JOIN authorization_grants g ON g.id = tf.grant_id
        WHERE rt.digest = ?
      `).get(digest);
      if (!row) {
        failure = ["invalid_refresh_token", "Refresh token is invalid", 400];
      } else if (row.client_id !== normalizedClientId || row.resource !== normalizedResource) {
        failure = ["invalid_refresh_token", "Refresh token binding does not match", 400];
      } else if (row.status !== "ACTIVE" || row.grant_status !== "ACTIVE"
        || Date.parse(row.expires_at) <= current.milliseconds
        || Date.parse(row.grant_expires_at) <= current.milliseconds
        || Date.parse(row.token_expires_at) <= current.milliseconds) {
        if (row.status === "ACTIVE" && Date.parse(row.expires_at) <= current.milliseconds) {
          this.db.prepare(`
            UPDATE oauth_token_families
            SET status = 'EXPIRED', revoked_at = ?, revoke_reason = 'expired'
            WHERE id = ? AND status = 'ACTIVE'
          `).run(current.value, row.id);
          this.db.prepare(`
            UPDATE oauth_refresh_tokens SET status = 'REVOKED'
            WHERE family_id = ? AND status = 'ACTIVE'
          `).run(row.id);
        }
        failure = ["refresh_inactive", "Refresh token family is inactive", 400];
      } else if (row.token_status !== "ACTIVE" || row.token_generation !== row.current_generation) {
        this.db.prepare(`
          UPDATE oauth_token_families
          SET status = 'COMPROMISED', revoked_at = ?, revoke_reason = 'refresh_reuse'
          WHERE id = ? AND status = 'ACTIVE'
        `).run(current.value, row.id);
        this.db.prepare(`
          UPDATE oauth_refresh_tokens SET status = 'REVOKED'
          WHERE family_id = ? AND status = 'ACTIVE'
        `).run(row.id);
        failure = ["refresh_reuse_detected", "Refresh token reuse compromised the token family", 400];
      } else {
        const consumed = this.db.prepare(`
          UPDATE oauth_refresh_tokens
          SET status = 'CONSUMED', consumed_at = ?
          WHERE digest = ? AND status = 'ACTIVE'
        `).run(current.value, digest);
        if (consumed.changes !== 1) throw new Error("refresh token changed during rotation");
        const nextGeneration = row.current_generation + 1;
        this.db.prepare(`
          INSERT INTO oauth_refresh_tokens (
            digest, family_id, generation, issued_at, expires_at, consumed_at, status
          ) VALUES (?, ?, ?, ?, ?, NULL, 'ACTIVE')
        `).run(nextDigest, row.id, nextGeneration, current.value, row.expires_at);
        this.db.prepare(`
          UPDATE oauth_token_families SET current_generation = ?
          WHERE id = ? AND status = 'ACTIVE' AND current_generation = ?
        `).run(nextGeneration, row.id, row.current_generation);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      if (error?.name === "AuthStoreError") throw error;
      throw authError("auth_storage_failure", "Refresh rotation state could not be committed", 503);
    }
    if (failure) throw authError(...failure);
    return {
      family: this.getTokenFamily(row.id, { now: current.value }),
      grant: this.getGrant(row.grant_id, { now: current.value }),
    };
  }

  revokeGrant({ grantId, ownerId, revokedAt = new Date().toISOString(), reason = "owner_revoke" }) {
    const revoked = isoTime("revokedAt", revokedAt);
    const grant = this.db.prepare("SELECT * FROM authorization_grants WHERE id = ?").get(grantId);
    if (!grant || grant.owner_id !== ownerId) throw authError("invalid_grant", "Grant is unavailable", 404);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db.prepare(`
        UPDATE authorization_grants SET status = 'REVOKED'
        WHERE id = ? AND owner_id = ? AND status = 'ACTIVE'
      `).run(grantId, ownerId);
      this.db.prepare(`
        UPDATE oauth_token_families
        SET status = 'REVOKED', revoked_at = ?, revoke_reason = ?
        WHERE grant_id = ? AND status IN ('ACTIVE','COMPROMISED')
      `).run(revoked.value, reason, grantId);
      this.db.prepare(`
        UPDATE oauth_refresh_tokens SET status = 'REVOKED'
        WHERE family_id IN (SELECT id FROM oauth_token_families WHERE grant_id = ?)
          AND status = 'ACTIVE'
      `).run(grantId);
      this.db.exec("COMMIT");
    } catch {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw authError("auth_storage_failure", "Grant revocation could not be committed", 503);
    }
    return this.getGrant(grantId, { now: revoked.value });
  }

  resetOwnerAccess({
    ownerId,
    bootstrapSecret,
    resetAt = new Date().toISOString(),
    bootstrapExpiresAt,
  }) {
    if (typeof bootstrapSecret !== "string" || bootstrapSecret.length < 32) {
      throw authError("invalid_bootstrap", "Owner bootstrap secret must contain at least 32 characters");
    }
    const reset = isoTime("resetAt", resetAt);
    const expires = isoTime("bootstrapExpiresAt", bootstrapExpiresAt);
    if (expires.milliseconds <= reset.milliseconds) {
      throw authError("invalid_bootstrap", "Owner bootstrap expiry must be after reset");
    }
    const owner = this.getOwner(ownerId);
    if (!owner) throw authError("invalid_owner", "Owner is unavailable", 404);
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db.prepare(`
        UPDATE authorization_grants SET status = 'REVOKED'
        WHERE owner_id = ? AND status = 'ACTIVE'
      `).run(ownerId);
      this.db.prepare(`
        UPDATE oauth_token_families
        SET status = 'RESET', revoked_at = ?, revoke_reason = 'owner_reset'
        WHERE owner_id = ? AND status IN ('ACTIVE','COMPROMISED')
      `).run(reset.value, ownerId);
      this.db.prepare(`
        UPDATE oauth_refresh_tokens SET status = 'REVOKED'
        WHERE family_id IN (SELECT id FROM oauth_token_families WHERE owner_id = ?)
          AND status = 'ACTIVE'
      `).run(ownerId);
      this.db.prepare("UPDATE oauth_clients SET status = 'DISABLED' WHERE owner_id = ?").run(ownerId);
      const updated = this.db.prepare(`
        UPDATE owners
        SET bootstrap_digest = ?, bootstrap_expires_at = ?, bootstrap_consumed_at = NULL, status = 'ACTIVE'
        WHERE id = ?
      `).run(hashSecret(bootstrapSecret), expires.value, ownerId);
      if (updated.changes !== 1) throw new Error("owner reset lost");
      this.db.exec("COMMIT");
    } catch {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw authError("auth_storage_failure", "Owner access reset could not be committed", 503);
    }
    return this.getOwner(ownerId);
  }

  ownerAccessSummary(ownerId) {
    const owner = this.getOwner(ownerId);
    if (!owner) throw authError("invalid_owner", "Owner is unavailable", 404);
    const count = (table, status) => Number(this.db.prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE owner_id = ? AND status = ?`,
    ).get(ownerId, status).count);
    return {
      ownerId,
      ownerStatus: owner.status,
      bootstrapPending: !owner.bootstrapConsumedAt,
      activeClients: count("oauth_clients", "ACTIVE"),
      activeGrants: count("authorization_grants", "ACTIVE"),
      activeTokenFamilies: count("oauth_token_families", "ACTIVE"),
      alreadyRunningTaskPolicy: "Revocation blocks new authorized requests; already-running tasks continue until explicitly interrupted or closed.",
    };
  }
}

export { AUTH_SCHEMA_VERSION };

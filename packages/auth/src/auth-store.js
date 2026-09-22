import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const AUTH_SCHEMA_VERSION = 1;
const OWNER_ID = /^[a-zA-Z0-9_-]{1,96}$/;
const OPAQUE_CLIENT_ID = /^[a-zA-Z0-9._~-]{8,256}$/;
const GRANT_ID = /^[a-zA-Z0-9_-]{8,128}$/;
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
    await this.recoverInterruptedMigration();
    const existed = await fs.stat(this.databasePath).then((entry) => entry.size > 0).catch(() => false);
    this.db = new DatabaseSync(this.databasePath);
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
        if (existing?.ownerId === ownerId && existing.redirectUri === callback && existing.status === "ACTIVE") {
          return existing;
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
}

export { AUTH_SCHEMA_VERSION };

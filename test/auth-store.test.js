import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AUTH_SCHEMA_VERSION, AuthStore } from "../packages/auth/src/auth-store.js";

const ownerId = "owner-primary";
const bootstrapSecret = "owner-bootstrap-secret-with-32-characters";
const clientId = "dcr_test_client_0123456789";
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const resource = "https://bridge.example.test/mcp";
const createdAt = "2026-09-22T20:00:00.000Z";
const bootstrapExpiresAt = "2026-09-22T20:10:00.000Z";
const refreshToken0 = "A".repeat(43);
const refreshToken1 = "B".repeat(43);
const refreshToken2 = "C".repeat(43);

async function temporaryStore(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-auth-store-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new AuthStore(dataDir, options);
  await store.init();
  t.after(() => store.close());
  return { dataDir, store };
}

function bootstrap(store) {
  store.createOwnerBootstrap({
    ownerId,
    secret: bootstrapSecret,
    createdAt,
    expiresAt: bootstrapExpiresAt,
  });
  return store.consumeOwnerBootstrap({
    secret: bootstrapSecret,
    now: "2026-09-22T20:01:00.000Z",
  });
}

test("AUTH-04: owner bootstrap is expiring, one-use, and stores no plaintext secret", async (t) => {
  const { dataDir, store } = await temporaryStore(t);
  const pending = store.createOwnerBootstrap({
    ownerId,
    secret: bootstrapSecret,
    createdAt,
    expiresAt: bootstrapExpiresAt,
  });
  assert.equal(pending.bootstrapConsumedAt, null);
  assert.rejects(
    async () => store.consumeOwnerBootstrap({
      secret: bootstrapSecret,
      now: "2026-09-22T20:11:00.000Z",
    }),
    { name: "AuthStoreError", code: "bootstrap_expired" },
  );
  assert.throws(
    () => store.consumeOwnerBootstrap({
      secret: "wrong-owner-bootstrap-secret-that-is-long-enough",
      now: "2026-09-22T20:01:00.000Z",
    }),
    { name: "AuthStoreError", code: "bootstrap_denied" },
  );
  const owner = store.consumeOwnerBootstrap({
    secret: bootstrapSecret,
    now: "2026-09-22T20:01:00.000Z",
  });
  assert.equal(owner.bootstrapConsumedAt, "2026-09-22T20:01:00.000Z");
  assert.throws(
    () => store.consumeOwnerBootstrap({
      secret: bootstrapSecret,
      now: "2026-09-22T20:02:00.000Z",
    }),
    { name: "AuthStoreError", code: "bootstrap_unavailable" },
  );
  assert.equal((await fs.readFile(path.join(dataDir, "auth.sqlite"))).includes(Buffer.from(bootstrapSecret)), false);
});

test("M002a persists client registration independently of bootstrap proof rotation", async (t) => {
  const { dataDir, store } = await temporaryStore(t);
  bootstrap(store);
  const registered = store.registerClient({ clientId, ownerId, redirectUri, createdAt });
  assert.equal(registered.redirectUri, redirectUri);
  store.close();

  const restarted = new AuthStore(dataDir);
  await restarted.init();
  t.after(() => restarted.close());
  assert.deepEqual(restarted.getClient(clientId), registered);
  assert.deepEqual(
    restarted.registerClient({ clientId, ownerId, redirectUri, createdAt }),
    registered,
  );
  assert.throws(
    () => restarted.registerClient({
      clientId,
      ownerId,
      redirectUri: "https://attacker.example/callback",
      createdAt,
    }),
    { name: "AuthStoreError", code: "client_conflict" },
  );

  const cimdClientId = "https://bridge.example.test/oauth/client-metadata.json";
  assert.equal(
    restarted.registerClient({ clientId: cimdClientId, ownerId, redirectUri, createdAt }).clientId,
    cimdClientId,
  );
  assert.throws(
    () => restarted.registerClient({
      clientId: "another_dcr_client_0123456789",
      ownerId,
      redirectUri: `${redirectUri}?unexpected=1`,
      createdAt,
    }),
    { name: "AuthStoreError", code: "invalid_auth_record" },
  );
});

test("AUTH-08: grants bind owner, client, exact scopes, profile and expiry", async (t) => {
  const { store } = await temporaryStore(t, { supportedScopes: ["files:read"] });
  bootstrap(store);
  store.registerClient({ clientId, ownerId, redirectUri, createdAt });

  const grant = store.createGrant({
    id: "grant-read-only-001",
    ownerId,
    clientId,
    resource,
    scopes: ["files:read", "files:read"],
    executionProfile: "files-read",
    grantedAt: "2026-09-22T20:02:00.000Z",
    expiresAt: "2026-09-22T21:02:00.000Z",
  });
  assert.deepEqual(grant.scopes, ["files:read"]);
  assert.equal(grant.ownerId, ownerId);
  assert.equal(grant.clientId, clientId);
  assert.equal(grant.resource, resource);
  assert.equal(grant.executionProfile, "files-read");
  assert.equal(store.getGrant(grant.id, { now: "2026-09-22T21:02:00.000Z" }).status, "EXPIRED");

  assert.throws(
    () => store.createGrant({
      id: "grant-escalated-001",
      ownerId,
      clientId,
      resource,
      scopes: ["terminal:execute"],
      expiresAt: "2026-09-22T21:02:00.000Z",
      grantedAt: "2026-09-22T20:02:00.000Z",
    }),
    { name: "AuthStoreError", code: "invalid_scope" },
  );

  assert.throws(
    () => store.createGrant({
      id: "grant-query-resource-001",
      ownerId,
      clientId,
      resource: `${resource}?unexpected=1`,
      scopes: ["files:read"],
      expiresAt: "2026-09-22T21:02:00.000Z",
      grantedAt: "2026-09-22T20:02:00.000Z",
    }),
    { name: "AuthStoreError", code: "invalid_auth_record" },
  );
});

test("AUTH-05/06/07: token families rotate atomically and revoke or compromise fail closed", async (t) => {
  const { dataDir, store } = await temporaryStore(t, { supportedScopes: ["files:read"] });
  bootstrap(store);
  store.registerClient({ clientId, ownerId, redirectUri, createdAt });
  const grant = store.createGrant({
    id: "grant-refresh-family-001",
    ownerId,
    clientId,
    resource,
    scopes: ["files:read"],
    executionProfile: "files-read",
    grantedAt: "2026-09-22T20:02:00.000Z",
    expiresAt: "2026-09-23T20:02:00.000Z",
  });
  const family = store.createTokenFamily({
    id: "family-refresh-001",
    grantId: grant.id,
    ownerId,
    clientId,
    resource,
    refreshToken: refreshToken0,
    createdAt: "2026-09-22T20:03:00.000Z",
    expiresAt: "2026-09-23T20:02:00.000Z",
  });
  assert.equal(family.currentGeneration, 0);
  assert.equal((await fs.readFile(path.join(dataDir, "auth.sqlite"))).includes(Buffer.from(refreshToken0)), false);

  const rotated = store.rotateRefreshToken({
    refreshToken: refreshToken0,
    nextRefreshToken: refreshToken1,
    clientId,
    resource,
    now: "2026-09-22T20:04:00.000Z",
  });
  assert.equal(rotated.family.currentGeneration, 1);
  assert.equal(rotated.family.status, "ACTIVE");

  assert.throws(
    () => store.rotateRefreshToken({
      refreshToken: refreshToken0,
      nextRefreshToken: refreshToken2,
      clientId,
      resource,
      now: "2026-09-22T20:05:00.000Z",
    }),
    { name: "AuthStoreError", code: "refresh_reuse_detected" },
  );
  assert.equal(store.getTokenFamily(family.id, { now: "2026-09-22T20:05:00.000Z" }).status, "COMPROMISED");
  assert.throws(
    () => store.rotateRefreshToken({
      refreshToken: refreshToken1,
      nextRefreshToken: refreshToken2,
      clientId,
      resource,
      now: "2026-09-22T20:06:00.000Z",
    }),
    { name: "AuthStoreError", code: "refresh_inactive" },
  );

  const secondGrant = store.createGrant({
    id: "grant-revoke-001",
    ownerId,
    clientId,
    resource,
    scopes: ["files:read"],
    grantedAt: "2026-09-22T20:07:00.000Z",
    expiresAt: "2026-09-23T20:02:00.000Z",
  });
  const secondFamily = store.createTokenFamily({
    id: "family-revoke-001",
    grantId: secondGrant.id,
    ownerId,
    clientId,
    resource,
    refreshToken: refreshToken2,
    createdAt: "2026-09-22T20:08:00.000Z",
    expiresAt: "2026-09-23T20:02:00.000Z",
  });
  assert.equal(store.revokeGrant({
    grantId: secondGrant.id,
    ownerId,
    revokedAt: "2026-09-22T20:09:00.000Z",
  }).status, "REVOKED");
  assert.equal(store.getTokenFamily(secondFamily.id, { now: "2026-09-22T20:09:00.000Z" }).status, "REVOKED");
  assert.match(store.ownerAccessSummary(ownerId).alreadyRunningTaskPolicy, /already-running tasks continue/);
});

test("AUTH-10: owner reset revokes credentials and retains transcript state for re-pair", async (t) => {
  const { store } = await temporaryStore(t, { supportedScopes: ["files:read"] });
  const transcriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-transcript-retained-"));
  t.after(() => fs.rm(transcriptDir, { recursive: true, force: true }));
  const transcript = path.join(transcriptDir, "session-output.log");
  await fs.writeFile(transcript, "retained transcript sentinel");
  bootstrap(store);
  store.registerClient({ clientId, ownerId, redirectUri, createdAt });
  const grant = store.createGrant({
    id: "grant-reset-001",
    ownerId,
    clientId,
    resource,
    scopes: ["files:read"],
    grantedAt: "2026-09-22T20:02:00.000Z",
    expiresAt: "2026-09-23T20:02:00.000Z",
  });
  store.createTokenFamily({
    id: "family-reset-001",
    grantId: grant.id,
    ownerId,
    clientId,
    resource,
    refreshToken: refreshToken0,
    createdAt: "2026-09-22T20:03:00.000Z",
    expiresAt: "2026-09-23T20:02:00.000Z",
  });

  const resetSecret = "replacement-owner-bootstrap-secret-0001";
  const resetOwner = store.resetOwnerAccess({
    ownerId,
    bootstrapSecret: resetSecret,
    resetAt: "2026-09-22T20:04:00.000Z",
    bootstrapExpiresAt: "2026-09-22T20:14:00.000Z",
  });
  assert.equal(resetOwner.bootstrapConsumedAt, null);
  assert.equal(store.getGrant(grant.id, { now: "2026-09-22T20:05:00.000Z" }).status, "REVOKED");
  assert.equal(await fs.readFile(transcript, "utf8"), "retained transcript sentinel");
  store.consumeOwnerBootstrap({ secret: resetSecret, now: "2026-09-22T20:05:00.000Z" });
  const repaired = store.registerClient({
    clientId,
    ownerId,
    redirectUri,
    createdAt: "2026-09-22T20:06:00.000Z",
  });
  assert.equal(repaired.status, "ACTIVE");
  assert.equal(store.ownerAccessSummary(ownerId).bootstrapPending, false);
});

test("M002a fails closed for a newer schema and recovers an interrupted first migration", async (t) => {
  const newerDir = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-auth-newer-"));
  t.after(() => fs.rm(newerDir, { recursive: true, force: true }));
  const newer = new DatabaseSync(path.join(newerDir, "auth.sqlite"));
  newer.exec(`PRAGMA user_version = ${AUTH_SCHEMA_VERSION + 1}`);
  newer.close();
  const incompatible = new AuthStore(newerDir);
  await assert.rejects(
    incompatible.init(),
    { name: "AuthStoreError", code: "auth_schema_incompatible" },
  );

  const recoveryDir = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-auth-recovery-"));
  t.after(() => fs.rm(recoveryDir, { recursive: true, force: true }));
  const backupPath = path.join(recoveryDir, "auth.sqlite.backup-v0");
  const backup = new DatabaseSync(backupPath);
  backup.close();
  await fs.writeFile(path.join(recoveryDir, "auth.sqlite"), "interrupted database");
  await fs.writeFile(path.join(recoveryDir, "auth.sqlite.migrating"), JSON.stringify({
    fromVersion: 0,
    targetVersion: AUTH_SCHEMA_VERSION,
    backupPath,
  }));

  const recovered = new AuthStore(recoveryDir);
  await recovered.init();
  t.after(() => recovered.close());
  const verification = new DatabaseSync(recovered.databasePath, { readOnly: true });
  assert.equal(verification.prepare("PRAGMA user_version").get().user_version, AUTH_SCHEMA_VERSION);
  assert.equal(verification.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  verification.close();
  await assert.rejects(fs.stat(recovered.migrationMarkerPath), { code: "ENOENT" });
});

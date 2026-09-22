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

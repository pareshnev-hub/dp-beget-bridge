import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { AuthStore } from "../packages/auth/src/auth-store.js";

const ownerId = "owner-primary";
const clientId = "dcr_admin_test_0123456789";
const redirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
const resource = "https://bridge.example.test/mcp";
const initialSecret = "initial-owner-admin-secret-with-32-characters";
const resetSecret = "replacement-owner-admin-secret-32-characters";
const refreshToken = "R".repeat(43);

function runAdmin(command, environment) {
  return spawnSync(process.execPath, ["scripts/auth-admin.mjs", command], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    encoding: "utf8",
  });
}

test("AUTH-05/AUTH-10 owner CLI revokes and resets without exposing secrets or deleting transcripts", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-auth-admin-"));
  const transcriptDir = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-auth-admin-transcript-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.after(() => fs.rm(transcriptDir, { recursive: true, force: true }));
  const transcriptPath = path.join(transcriptDir, "retained.log");
  await fs.writeFile(transcriptPath, "retained transcript sentinel");

  const store = new AuthStore(dataDir, { supportedScopes: ["files:read"] });
  await store.init();
  store.createOwnerBootstrap({
    ownerId,
    secret: initialSecret,
    createdAt: "2026-09-22T20:00:00.000Z",
    expiresAt: "2026-09-22T20:10:00.000Z",
  });
  store.consumeOwnerBootstrap({ secret: initialSecret, now: "2026-09-22T20:01:00.000Z" });
  store.registerClient({
    clientId,
    ownerId,
    redirectUri,
    createdAt: "2026-09-22T20:01:00.000Z",
  });
  const grant = store.createGrant({
    id: "grant-admin-cli-001",
    ownerId,
    clientId,
    resource,
    scopes: ["files:read"],
    grantedAt: "2026-09-22T20:02:00.000Z",
    expiresAt: "2026-09-23T20:02:00.000Z",
  });
  const family = store.createTokenFamily({
    id: "family-admin-cli-001",
    grantId: grant.id,
    ownerId,
    clientId,
    resource,
    refreshToken,
    createdAt: "2026-09-22T20:03:00.000Z",
    expiresAt: "2026-09-23T20:02:00.000Z",
  });
  store.close();

  const environment = { DP_AUTH_DATA_DIR: dataDir, DP_OWNER_ID: ownerId };
  const status = runAdmin("status", environment);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /active_grants=1/);
  assert.match(status.stdout, /already-running tasks continue/);
  assert.equal(status.stdout.includes(initialSecret), false);
  assert.equal(status.stdout.includes(refreshToken), false);

  const denied = runAdmin("revoke-all", environment);
  assert.notEqual(denied.status, 0);
  const revoked = runAdmin("revoke-all", { ...environment, DP_AUTH_ADMIN_CONFIRM: "REVOKE" });
  assert.equal(revoked.status, 0, revoked.stderr);
  assert.match(revoked.stdout, /OWNER_ACCESS_REVOKED/);
  assert.match(revoked.stdout, /active_grants=0/);

  const afterRevoke = new AuthStore(dataDir, { supportedScopes: ["files:read"] });
  await afterRevoke.init();
  assert.equal(afterRevoke.getGrant(grant.id).status, "REVOKED");
  assert.equal(afterRevoke.getTokenFamily(family.id).status, "REVOKED");
  afterRevoke.close();

  const reset = runAdmin("reset", {
    ...environment,
    DP_AUTH_ADMIN_CONFIRM: "RESET",
    DP_OWNER_BOOTSTRAP_SECRET: resetSecret,
  });
  assert.equal(reset.status, 0, reset.stderr);
  assert.match(reset.stdout, /re_pair_required=true transcripts=retained/);
  assert.equal(reset.stdout.includes(resetSecret), false);
  assert.equal(await fs.readFile(transcriptPath, "utf8"), "retained transcript sentinel");

  const resetStore = new AuthStore(dataDir, { supportedScopes: ["files:read"] });
  await resetStore.init();
  assert.equal(resetStore.getOwner(ownerId).bootstrapConsumedAt, null);
  assert.equal(resetStore.getClient(clientId).status, "DISABLED");
  resetStore.consumeOwnerBootstrap({ secret: resetSecret });
  assert.equal(resetStore.registerClient({
    clientId,
    ownerId,
    redirectUri,
  }).status, "ACTIVE");
  resetStore.close();
});

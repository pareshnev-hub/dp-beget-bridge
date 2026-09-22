import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { AuthStore } from "../packages/auth/src/auth-store.js";

test("AUTH-04 runtime bootstrap is one-use, durable and idempotent", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-auth-bootstrap-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const secret = "runtime-owner-bootstrap-secret-with-32-characters";
  const environment = {
    ...process.env,
    DP_AUTH_DATA_DIR: dataDir,
    DP_OWNER_ID: "owner-primary",
    DP_OWNER_BOOTSTRAP_SECRET: secret,
  };

  const first = spawnSync(process.execPath, ["scripts/auth-bootstrap.mjs"], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^OWNER_BOOTSTRAPPED id=owner-primary\s*$/);

  const store = new AuthStore(dataDir);
  await store.init();
  const owner = store.getOwner("owner-primary");
  assert.equal(owner.status, "ACTIVE");
  assert.ok(owner.bootstrapConsumedAt);
  store.close();

  const second = spawnSync(process.execPath, ["scripts/auth-bootstrap.mjs"], {
    cwd: process.cwd(),
    env: { ...environment, DP_OWNER_BOOTSTRAP_SECRET: "rotated-secret-that-is-also-long-enough" },
    encoding: "utf8",
  });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^OWNER_ALREADY_BOOTSTRAPPED id=owner-primary\s*$/);

  const bytes = await fs.readFile(path.join(dataDir, "auth.sqlite"));
  assert.equal((await fs.stat(dataDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(dataDir, "auth.sqlite"))).mode & 0o777, 0o600);
  assert.equal(bytes.includes(Buffer.from(secret)), false);
  assert.equal(first.stdout.includes(secret), false);
  assert.equal(second.stdout.includes(secret), false);
});

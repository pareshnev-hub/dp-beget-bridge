import path from "node:path";
import { AuthStore } from "../packages/auth/src/auth-store.js";

function positiveInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isFinite(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const dataDir = path.resolve(process.env.DP_AUTH_DATA_DIR || "./runtime/auth");
const ownerId = process.env.DP_OWNER_ID || "owner-primary";
const secret = process.env.DP_OWNER_BOOTSTRAP_SECRET
  || process.env.DP_OAUTH_STAGING_APPROVAL_SECRET
  || "";
const ttlMs = positiveInteger("DP_OWNER_BOOTSTRAP_TTL_MS", 10 * 60 * 1000);

if (!/^[a-zA-Z0-9_-]{1,96}$/.test(ownerId)) throw new Error("DP_OWNER_ID is invalid");
if (secret.length < 32) throw new Error("Owner bootstrap secret must contain at least 32 characters");

const store = new AuthStore(dataDir);
await store.init();
try {
  let owner = store.getOwner(ownerId);
  if (!owner) {
    const createdAt = new Date();
    store.createOwnerBootstrap({
      ownerId,
      secret,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
    });
    owner = store.getOwner(ownerId);
  }
  if (owner.status !== "ACTIVE") throw new Error("OAuth owner is disabled");
  if (!owner.bootstrapConsumedAt) {
    owner = store.consumeOwnerBootstrap({ secret });
    console.log(`OWNER_BOOTSTRAPPED id=${owner.id}`);
  } else {
    console.log(`OWNER_ALREADY_BOOTSTRAPPED id=${owner.id}`);
  }
} finally {
  store.close();
}

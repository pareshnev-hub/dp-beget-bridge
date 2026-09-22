import path from "node:path";
import { AuthStore } from "../packages/auth/src/auth-store.js";

function positiveInteger(name, fallback) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isFinite(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const command = process.argv[2] || "status";
if (!["status", "revoke-all", "reset"].includes(command)) {
  throw new Error("Usage: node scripts/auth-admin.mjs status|revoke-all|reset");
}

const dataDir = path.resolve(process.env.DP_AUTH_DATA_DIR || "/var/lib/dp-beget-bridge-mcp/auth");
const ownerId = process.env.DP_OWNER_ID || "owner-primary";
const store = new AuthStore(dataDir);
await store.init();

function printSummary(summary) {
  console.log([
    `OWNER_ACCESS_STATUS owner=${summary.ownerId}`,
    `owner_status=${summary.ownerStatus}`,
    `bootstrap=${summary.bootstrapPending ? "pending" : "complete"}`,
    `active_clients=${summary.activeClients}`,
    `active_grants=${summary.activeGrants}`,
    `active_token_families=${summary.activeTokenFamilies}`,
  ].join(" "));
  console.log(`RUNNING_TASK_POLICY ${summary.alreadyRunningTaskPolicy}`);
}

try {
  if (command === "status") {
    printSummary(store.ownerAccessSummary(ownerId));
  } else if (command === "revoke-all") {
    if (process.env.DP_AUTH_ADMIN_CONFIRM !== "REVOKE") {
      throw new Error("Set DP_AUTH_ADMIN_CONFIRM=REVOKE to revoke owner access");
    }
    const summary = store.revokeOwnerAccess({ ownerId });
    console.log(`OWNER_ACCESS_REVOKED owner=${ownerId}`);
    printSummary(summary);
  } else {
    if (process.env.DP_AUTH_ADMIN_CONFIRM !== "RESET") {
      throw new Error("Set DP_AUTH_ADMIN_CONFIRM=RESET to reset and require re-pair");
    }
    const secret = process.env.DP_OWNER_BOOTSTRAP_SECRET
      || process.env.DP_OAUTH_STAGING_APPROVAL_SECRET
      || "";
    if (secret.length < 32) throw new Error("Owner reset requires a bootstrap secret with 32+ characters");
    const resetAt = new Date();
    const ttlMs = positiveInteger("DP_OWNER_BOOTSTRAP_TTL_MS", 10 * 60 * 1000);
    store.resetOwnerAccess({
      ownerId,
      bootstrapSecret: secret,
      resetAt: resetAt.toISOString(),
      bootstrapExpiresAt: new Date(resetAt.getTime() + ttlMs).toISOString(),
    });
    console.log(`OWNER_ACCESS_RESET owner=${ownerId} re_pair_required=true transcripts=retained`);
    printSummary(store.ownerAccessSummary(ownerId));
  }
} finally {
  store.close();
}

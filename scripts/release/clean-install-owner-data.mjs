import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadCleanInstallAuthConfiguration } from "./clean-install-auth-profile.mjs";
import { inspectCreatedCleanIdentities } from "./inspect-clean-install-created-identities.mjs";

const exec = promisify(execFile);

export async function inspectCleanOwnerData({ dataRoot = "/var/lib", identities } = {}) {
  if (identities?.identities !== "journal-bound") throw new Error("Bound clean owner identity required");
  const directory = path.join(dataRoot, "dp-beget-bridge-mcp", "auth");
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== identities.mcpUid || info.gid !== identities.mcpGid ||
      (info.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) {
    throw new Error("Untrusted clean owner data directory");
  }
  const names = await readdir(directory);
  if (!names.includes("auth.sqlite") || names.some(name =>
    !["auth.sqlite", "auth.sqlite-wal", "auth.sqlite-shm"].includes(name))) {
    throw new Error("Untrusted clean owner data inventory");
  }
  let databaseInfo;
  for (const name of names) {
    const filename = path.join(directory, name);
    const entry = await lstat(filename);
    if (!entry.isFile() || entry.uid !== identities.mcpUid || entry.gid !== identities.mcpGid ||
        entry.nlink !== 1 || (entry.mode & 0o777) !== 0o600 || entry.size > 128 * 1024 * 1024 ||
        await realpath(filename) !== filename) throw new Error("Untrusted clean owner data file");
    if (name === "auth.sqlite") databaseInfo = entry;
  }
  return { directory, database: path.join(directory, "auth.sqlite"), databaseInfo };
}

export async function inspectInitializedCleanOwner({ journal, trustDir, dataRoot = "/var/lib" } = {}) {
  if (process.getuid?.() !== 0 || !journal) throw new Error("Root and journal required to inspect clean owner");
  const profile = await loadCleanInstallAuthConfiguration({ workspace: journal.workspace,
    manifestSha256: journal.manifestSha256, trustDir });
  if (profile.authMode !== "oauth") throw new Error("Clean owner requires OAuth profile");
  const identities = await inspectCreatedCleanIdentities({ plan: journal.identityPlan, transactionId: journal.transactionId });
  const before = await inspectCleanOwnerData({ dataRoot, identities });
  const expected = createHash("sha256").update("DP-013 owner bootstrap v1\0").update(profile.approvalSecret).digest("hex");
  // SQLite may create WAL/SHM coordination files even for read-only queries.
  // Inspect under the exact service identity, never creating root-owned
  // files inside a service-owned database directory.
  const source = `import { DatabaseSync } from 'node:sqlite';
    let db;
    try {
      db = new DatabaseSync(process.env.DP_CLEAN_OWNER_DB, {readOnly:true});
      if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' ||
          db.prepare('PRAGMA user_version').get().user_version !== 2) throw Error('invalid');
      const owners=db.prepare('SELECT id,singleton,status,bootstrap_digest,bootstrap_consumed_at FROM owners').all();
      if (owners.length!==1 || owners[0].id!==process.env.DP_CLEAN_OWNER_ID || owners[0].singleton!==1 ||
          owners[0].status!=='ACTIVE' || owners[0].bootstrap_digest!==process.env.DP_CLEAN_OWNER_DIGEST ||
          !Number.isFinite(Date.parse(owners[0].bootstrap_consumed_at))) throw Error('invalid');
      for (const table of ['oauth_clients','authorization_grants','oauth_token_families','oauth_refresh_tokens']) {
        if(db.prepare('SELECT count(*) AS count FROM '+table).get().count!==0) throw Error('invalid');
      }
      console.log('CLEAN_OWNER_BOUND');
    } catch { process.exitCode=1; }
    finally { db?.close(); }`;
  try {
    const result = await exec("runuser", ["-u", journal.identityPlan.mcpUser, "--",
      process.execPath, "--input-type=module", "--eval", source], {
      env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        DP_CLEAN_OWNER_DB: before.database, DP_CLEAN_OWNER_ID: profile.ownerId,
        DP_CLEAN_OWNER_DIGEST: expected }, timeout: 10000, maxBuffer: 4096 });
    if (result.stdout !== "CLEAN_OWNER_BOUND\n") throw new Error("Unexpected clean owner proof");
  } catch { throw new Error("Clean initialized owner is unproven"); }
  const after = await inspectCleanOwnerData({ dataRoot, identities });
  if (after.databaseInfo.ino !== before.databaseInfo.ino || after.databaseInfo.dev !== before.databaseInfo.dev) {
    throw new Error("Clean owner database changed during inspection");
  }
  return { owner: "candidate-bound", ownerId: profile.ownerId };
}

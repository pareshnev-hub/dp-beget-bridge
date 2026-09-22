import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2]);

export function inspectSessionHostRestart(databasePath) {
  if (!fs.existsSync(databasePath)) {
    throw new Error("state database is missing");
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const schemaVersion = Number(database.prepare("PRAGMA user_version").get().user_version);
    if (!SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion)) {
      throw new Error(`unsupported state schema ${schemaVersion}`);
    }

    const integrity = database.prepare("PRAGMA quick_check").get().quick_check;
    if (integrity !== "ok") throw new Error("state database integrity check failed");

    const operationsTable = database.prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table' AND name = 'operations'
    `).get();
    if (!operationsTable) throw new Error("operations table is missing");

    const active = database.prepare(`
      SELECT COUNT(*) AS count
      FROM operations
      WHERE status IN ('ACCEPTED', 'RUNNING')
    `).get();
    return { schemaVersion, activeOperationCount: Number(active.count) };
  } finally {
    database.close();
  }
}

export function assertSessionHostRestartSafe(databasePath) {
  const result = inspectSessionHostRestart(databasePath);
  if (result.activeOperationCount > 0) {
    throw new Error(`${result.activeOperationCount} accepted or running operation(s) remain`);
  }
  return result;
}

function main() {
  const databasePath = path.resolve(process.argv[2] || "/var/lib/dp-beget-bridge/state.sqlite");
  let result;
  try {
    result = assertSessionHostRestartSafe(databasePath);
  } catch (error) {
    console.error(`Refusing Session Host restart: ${error.message}.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Session Host restart preflight passed (state schema ${result.schemaVersion}; no active operations).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

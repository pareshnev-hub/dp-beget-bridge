#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, realpath, rm, stat, statfs, writeFile } from "node:fs/promises";
import { DatabaseSync, backup } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FREE_RESERVE = 256 * 1024 * 1024;

async function digestFile(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

export async function backupSqliteSet({ databases, outputDir, minFreeBytes = DEFAULT_FREE_RESERVE }) {
  if (!Array.isArray(databases) || databases.length === 0 || !path.isAbsolute(outputDir || "") ||
      !Number.isSafeInteger(minFreeBytes) || minFreeBytes < 0) {
    throw new Error("Database list, absolute new backup directory and free-space reserve are required");
  }
  const output = path.resolve(outputDir);
  const parent = path.dirname(output);
  if ((await realpath(parent)) !== parent) throw new Error("Backup parent must be a real directory");
  const names = new Set();
  const sources = new Set();
  let estimated = 0;
  for (const item of databases) {
    if (!item || typeof item.name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(item.name) ||
        !path.isAbsolute(item.source || "") || names.has(item.name) || sources.has(path.resolve(item.source))) {
      throw new Error("Database labels and sources must be distinct and valid");
    }
    names.add(item.name);
    sources.add(path.resolve(item.source));
    const info = await lstat(item.source);
    if (!info.isFile()) throw new Error("Database source must be a regular file");
    estimated += info.size;
  }
  const available = await statfs(parent);
  if (available.bavail * available.bsize < estimated * 2 + minFreeBytes) {
    throw new Error("Insufficient free space for a recoverable database backup");
  }
  await mkdir(output, { mode: 0o700 });
  const records = [];
  try {
    for (const { name, source } of databases) {
      const destination = path.join(output, `${name}.sqlite`);
      const db = new DatabaseSync(source, { readOnly: true });
      let sourceVersion;
      try {
        if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw new Error("Source SQLite integrity failed");
        sourceVersion = Number(db.prepare("PRAGMA user_version").get().user_version);
        await backup(db, destination, { rate: 100, timeout: 5000 });
      } finally { db.close(); }
      await chmod(destination, 0o600);
      const copy = new DatabaseSync(destination);
      try {
        // Make the backed-up database self-contained. Checking a WAL-mode copy
        // read-only creates -wal/-shm sidecars that are not part of the manifest.
        copy.exec("PRAGMA journal_mode=DELETE");
        if (copy.prepare("PRAGMA quick_check").get().quick_check !== "ok" ||
            Number(copy.prepare("PRAGMA user_version").get().user_version) !== sourceVersion) {
          throw new Error("Backup SQLite integrity or schema check failed");
        }
      } finally { copy.close(); }
      records.push({ name, schemaVersion: sourceVersion, size: (await stat(destination)).size,
        sha256: await digestFile(destination) });
    }
    const manifest = { format: "dp-beget-bridge-sqlite-backup-v1", createdAt: new Date().toISOString(), databases: records };
    await writeFile(path.join(output, "backup-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return manifest;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

async function main(args) {
  if (args.length < 4 || args[0] !== "--output-dir" || !args[1] || (args.length - 2) % 2 !== 0) {
    throw new Error("Usage: backup-sqlite --output-dir NEW_DIRECTORY --database LABEL=ABSOLUTE_PATH [--database LABEL=ABSOLUTE_PATH ...]");
  }
  const databases = [];
  for (let i = 2; i < args.length; i += 2) {
    if (args[i] !== "--database" || !args[i + 1]?.includes("=")) throw new Error("Invalid --database argument");
    const at = args[i + 1].indexOf("=");
    databases.push({ name: args[i + 1].slice(0, at), source: args[i + 1].slice(at + 1) });
  }
  const result = await backupSqliteSet({ databases, outputDir: args[1] });
  console.log(`Verified SQLite backup contains ${result.databases.map(item => item.name).join(", ")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`SQLite backup failed (${error.code || "validation"})`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, lstat, mkdir, open, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRegularFile } from "./verify-artifact.mjs";

const MANIFEST = "backup-manifest.json";
const MAX_CONFIG_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 128;
const HEX = /^[0-9a-f]{64}$/;

function validName(name) {
  return typeof name === "string" && name.length > 0 &&
    name.split("/").every(part => /^[a-zA-Z0-9._-]+$/.test(part) && part !== "." && part !== "..");
}

async function roots(backupDir, outputDir) {
  if (!path.isAbsolute(backupDir || "") || !path.isAbsolute(outputDir || "")) {
    throw new Error("Absolute backup and new restore directory paths are required");
  }
  const backup = path.resolve(backupDir);
  const output = path.resolve(outputDir);
  if (backup === output || backup.startsWith(`${output}${path.sep}`) || output.startsWith(`${backup}${path.sep}`) ||
      (await realpath(backup)) !== backup || (await realpath(path.dirname(output))) !== path.dirname(output) ||
      !(await lstat(backup)).isDirectory()) {
    throw new Error("Backup and restore paths must be separate real directories");
  }
  // The backup itself must remain private, even if its parent is traversable.
  if (((await stat(backup)).mode & 0o077) !== 0) throw new Error("Backup directory is not private");
  return { backup, output };
}

async function manifestOf(backup, format) {
  const bytes = await readRegularFile(path.join(backup, MANIFEST), 64 * 1024);
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Invalid backup manifest"); }
  if (manifest?.format !== format) throw new Error("Invalid backup manifest format");
  return manifest;
}

async function inventory(directory, prefix = "") {
  const found = [];
  for (const item of await readdir(directory)) {
    const name = prefix ? `${prefix}/${item}` : item;
    if (!validName(name)) throw new Error("Unsafe backup entry name");
    const filename = path.join(directory, item);
    const info = await lstat(filename);
    if ((!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1)) {
      throw new Error("Backup contains a link or special file");
    }
    found.push(name);
    if (found.length > MAX_ENTRIES + 1) throw new Error("Backup entry limit exceeded");
    if (info.isDirectory()) found.push(...await inventory(filename, name));
  }
  return found;
}

async function verifiedBytes(filename, size, sha256, maxBytes) {
  if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes || typeof sha256 !== "string" || !HEX.test(sha256)) {
    throw new Error("Invalid backup file record");
  }
  const bytes = await readRegularFile(filename, maxBytes);
  if (bytes.length !== size || createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new Error("Backup checksum mismatch");
  }
  return bytes;
}

function mode(value) { return Number.isInteger(value) && value >= 0 && value <= 0o777; }
function owner(value) { return Number.isSafeInteger(value) && value >= 0; }

async function setOwnership(filename, record) {
  const current = await stat(filename);
  if (current.uid !== record.uid || current.gid !== record.gid) await chown(filename, record.uid, record.gid);
  await chmod(filename, record.mode);
}

export async function restoreConfig({ backupDir, outputDir }) {
  const { backup, output } = await roots(backupDir, outputDir);
  const manifest = await manifestOf(backup, "dp-beget-bridge-config-backup-v1");
  if (!mode(manifest.rootMode) || !Array.isArray(manifest.entries) || manifest.entries.length > MAX_ENTRIES) {
    throw new Error("Invalid configuration backup manifest");
  }
  const entries = manifest.entries;
  const seen = new Set();
  const files = new Map();
  let total = 0;
  for (const entry of entries) {
    if (!validName(entry?.path) || entry.path === MANIFEST || seen.has(entry.path) ||
        !mode(entry.mode) || !owner(entry.uid) || !owner(entry.gid) ||
        !["file", "directory"].includes(entry.type)) {
      throw new Error("Invalid configuration backup entry");
    }
    seen.add(entry.path);
    const parent = path.posix.dirname(entry.path);
    if (parent !== "." && !entries.some(item => item.path === parent && item.type === "directory")) {
      throw new Error("Configuration backup has an undeclared parent");
    }
    if (entry.type === "file") {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("Invalid configuration file size");
      total += entry.size;
      if (total > MAX_CONFIG_BYTES) throw new Error("Configuration backup exceeds its safety ceiling");
      files.set(entry.path, await verifiedBytes(path.join(backup, entry.path), entry.size, entry.sha256, MAX_CONFIG_BYTES));
    } else if (!(await lstat(path.join(backup, entry.path))).isDirectory()) {
      throw new Error("Configuration backup directory mismatch");
    }
  }
  const actual = await inventory(backup);
  if (actual.length !== seen.size + 1 || !actual.includes(MANIFEST) || actual.some(name => name !== MANIFEST && !seen.has(name))) {
    throw new Error("Configuration backup contains unrecorded entries");
  }
  await mkdir(output, { mode: 0o700 });
  try {
    // Create parent directories first, and set their restrictive original modes last.
    for (const entry of entries.filter(item => item.type === "directory").sort((a, b) => a.path.length - b.path.length)) {
      await mkdir(path.join(output, entry.path), { mode: 0o700 });
    }
    for (const entry of entries.filter(item => item.type === "file")) {
      const target = path.join(output, entry.path);
      await writeFile(target, files.get(entry.path), { flag: "wx", mode: 0o600 });
      await setOwnership(target, entry);
    }
    for (const entry of entries.filter(item => item.type === "directory").sort((a, b) => b.path.length - a.path.length)) {
      await setOwnership(path.join(output, entry.path), entry);
    }
    await chmod(output, manifest.rootMode);
    return { entries: entries.length };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreSqliteSet({ backupDir, outputDir }) {
  const { backup, output } = await roots(backupDir, outputDir);
  const manifest = await manifestOf(backup, "dp-beget-bridge-sqlite-backup-v2");
  if (!Array.isArray(manifest.databases) || manifest.databases.length === 0 || manifest.databases.length > MAX_ENTRIES) {
    throw new Error("Invalid SQLite backup manifest");
  }
  const entries = manifest.databases;
  const names = new Set();
  for (const entry of entries) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(entry?.name || "") || names.has(entry.name) ||
        !Number.isSafeInteger(entry.schemaVersion) || entry.schemaVersion < 0 ||
        !owner(entry.uid) || !owner(entry.gid) || !mode(entry.mode)) {
      throw new Error("Invalid SQLite backup record");
    }
    names.add(entry.name);
    const filename = path.join(backup, `${entry.name}.sqlite`);
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || !Number.isSafeInteger(entry.size) || entry.size !== info.size ||
          typeof entry.sha256 !== "string" || !HEX.test(entry.sha256)) throw new Error("Invalid SQLite backup file");
      const hash = createHash("sha256");
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
      if (hash.digest("hex") !== entry.sha256) throw new Error("Backup checksum mismatch");
    } finally { await handle.close(); }
    // Open the restored copy for SQLite checks below: opening a WAL database here
    // could create sidecars in the immutable backup directory.
  }
  const actual = await inventory(backup);
  if (actual.length !== names.size + 1 || !actual.includes(MANIFEST) ||
      actual.some(name => name !== MANIFEST && !names.has(name.replace(/\.sqlite$/, "")))) {
    throw new Error("SQLite backup contains unrecorded entries");
  }
  await mkdir(output, { mode: 0o700 });
  try {
    for (const entry of entries) {
      const source = path.join(backup, `${entry.name}.sqlite`);
      const destination = path.join(output, `${entry.name}.sqlite`);
      // Recheck the exact bytes copied, since a backup may change after the first validation.
      const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const destinationHandle = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          const hash = createHash("sha256");
          let size = 0;
          for await (const chunk of sourceHandle.createReadStream({ autoClose: false })) {
            size += chunk.length;
            if (size > entry.size) throw new Error("Backup changed during restore");
            hash.update(chunk);
            await destinationHandle.writeFile(chunk);
          }
          if (size !== entry.size || hash.digest("hex") !== entry.sha256) throw new Error("Backup changed during restore");
          await destinationHandle.sync();
        } finally { await destinationHandle.close(); }
      } finally { await sourceHandle.close(); }
      const db = new DatabaseSync(destination, { readOnly: true });
      try {
        if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok" ||
            Number(db.prepare("PRAGMA user_version").get().user_version) !== entry.schemaVersion) {
          throw new Error("Restored SQLite integrity or schema mismatch");
        }
      } finally { db.close(); }
      const restored = await stat(destination);
      if (restored.uid !== entry.uid || restored.gid !== entry.gid) {
        await chown(destination, entry.uid, entry.gid);
      }
      await chmod(destination, entry.mode);
    }
    return { databases: entries.map(entry => entry.name) };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

async function main(args) {
  if (args.length !== 5 || !["config", "sqlite"].includes(args[0]) ||
      args[1] !== "--backup-dir" || args[3] !== "--output-dir") {
    throw new Error("Usage: restore-backup (config|sqlite) --backup-dir ABSOLUTE_DIRECTORY --output-dir NEW_DIRECTORY");
  }
  const restore = args[0] === "config" ? restoreConfig : restoreSqliteSet;
  await restore({ backupDir: args[2], outputDir: args[4] });
  console.log("Backup restored and verified into a new private directory");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Backup restore failed (${error.code || "validation"})`);
    process.exitCode = 1;
  });
}

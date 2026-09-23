#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, realpath, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRegularFile } from "./verify-artifact.mjs";

const UNITS = ["dp-beget-session-host.service", "dp-beget-agent.service",
  "dp-beget-mcp.service", "dp-beget-mcp-oauth-spike.service",
  "dp-beget-oauth-proxy.socket", "dp-beget-oauth-proxy.service", "dp-beget-tunnel.service"];
const MAX_MANIFEST_BYTES = 64 * 1024;

async function privateDirectory(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o077) !== 0 ||
      (await realpath(directory)) !== directory) throw new Error("Untrusted unit backup directory");
}

async function walk(directory, relative = "") {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await privateDirectory(child);
      paths.push(...await walk(child, name));
    } else if (entry.isFile()) paths.push(name);
    else throw new Error("Unit backup contains a link or special file");
  }
  return paths.sort();
}

export async function verifySystemdUnitBackup({ backupDir }) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to verify a systemd unit backup");
  if (!path.isAbsolute(backupDir || "") || path.normalize(backupDir) !== backupDir) {
    throw new Error("Normalized absolute backup directory required");
  }
  await privateDirectory(backupDir);
  const manifestPath = path.join(backupDir, "backup-manifest.json");
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.nlink !== 1 || manifestInfo.uid !== 0 ||
      (manifestInfo.mode & 0o077) !== 0 || (await realpath(manifestPath)) !== manifestPath) {
    throw new Error("Untrusted unit backup manifest");
  }
  const bytes = await readRegularFile(manifestPath, MAX_MANIFEST_BYTES);
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.format !== "dp-beget-bridge-unit-backup-v1" || !Array.isArray(manifest.files) ||
      manifest.files.length < UNITS.length || manifest.files.length > 32) {
    throw new Error("Invalid unit backup manifest");
  }
  const seen = new Set();
  for (const item of manifest.files) {
    if (!UNITS.includes(item.unit) || typeof item.path !== "string" ||
        (item.path !== item.unit && !new RegExp(`^${item.unit.replaceAll(".", "\\.")}\\.d/[A-Za-z0-9._-]+\\.conf$`).test(item.path)) ||
        seen.has(item.path) || !/^[0-9a-f]{64}$/.test(item.sha256) ||
        !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 64 * 1024 ||
        !Number.isInteger(item.mode) || item.uid !== 0 || !Number.isInteger(item.gid)) {
      throw new Error("Invalid unit backup file record");
    }
    seen.add(item.path);
    const filename = path.join(backupDir, "files", item.path);
    const info = await lstat(filename);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o077) !== 0 ||
        (await realpath(filename)) !== filename || info.size !== item.size) {
      throw new Error("Untrusted unit backup file");
    }
    const content = await readRegularFile(filename, 64 * 1024);
    if (createHash("sha256").update(content).digest("hex") !== item.sha256) {
      throw new Error("Unit backup file digest mismatch");
    }
  }
  if (UNITS.some(unit => !seen.has(unit))) throw new Error("Missing required unit fragment");
  await privateDirectory(path.join(backupDir, "files"));
  if (JSON.stringify(await walk(path.join(backupDir, "files"))) !== JSON.stringify([...seen].sort())) {
    throw new Error("Unexpected unit backup file inventory");
  }
  return { manifestSha256: createHash("sha256").update(bytes).digest("hex"), files: seen.size };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error("Usage: verify-systemd-unit-backup ABSOLUTE_BACKUP_DIR");
    process.exitCode = 1;
  } else verifySystemdUnitBackup({ backupDir: process.argv[2] }).then(result => {
    console.log(`Verified ${result.files} unit files; manifest SHA-256 ${result.manifestSha256}`);
  }).catch(error => {
    console.error(`Unit backup verification failed (${error.code || "validation"})`);
    process.exitCode = 1;
  });
}

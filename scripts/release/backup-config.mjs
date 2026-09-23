#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRegularFile } from "./verify-artifact.mjs";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 128;

async function inspect(directory, relative, entries, total) {
  const listing = await readdir(directory, { withFileTypes: true });
  listing.sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const item of listing) {
    if (!/^[a-zA-Z0-9._-]+$/.test(item.name) || [".", ".."].includes(item.name)) {
      throw new Error("Unsupported configuration entry name");
    }
    const source = path.join(directory, item.name);
    const name = relative ? `${relative}/${item.name}` : item.name;
    const info = await lstat(source);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()) || (info.isFile() && info.nlink !== 1)) {
      throw new Error("Configuration links and special files cannot be backed up");
    }
    if (info.isFile()) total.count += info.size;
    if (total.count > MAX_BYTES || entries.length >= MAX_ENTRIES) {
      throw new Error("Configuration backup exceeds its safety ceiling");
    }
    entries.push({ source, name, info, directory: info.isDirectory() });
    if (info.isDirectory()) await inspect(source, name, entries, total);
  }
}

export async function backupConfig({ configRoot, outputDir }) {
  if (!path.isAbsolute(configRoot || "") || !path.isAbsolute(outputDir || "")) {
    throw new Error("Absolute configuration and new backup directory paths are required");
  }
  const source = path.resolve(configRoot);
  const output = path.resolve(outputDir);
  const rootInfo = await lstat(source);
  if (!rootInfo.isDirectory() || (await realpath(source)) !== source ||
      source === output || output.startsWith(`${source}${path.sep}`) || source.startsWith(`${output}${path.sep}`) ||
      (await realpath(path.dirname(output))) !== path.dirname(output)) {
    throw new Error("Configuration and backup must be separate real directories");
  }
  const entries = [];
  await inspect(source, "", entries, { count: 0 });
  await mkdir(output, { mode: 0o700 });
  try {
    const records = [];
    for (const entry of entries) {
      const destination = path.join(output, entry.name);
      const base = { path: entry.name, mode: entry.info.mode & 0o777, uid: entry.info.uid, gid: entry.info.gid };
      if (entry.directory) {
        await mkdir(destination, { mode: 0o700 });
        records.push({ ...base, type: "directory" });
      } else {
        const bytes = await readRegularFile(entry.source, MAX_BYTES);
        if (bytes.length !== entry.info.size) throw new Error("Configuration changed during backup");
        await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
        records.push({ ...base, type: "file", size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
    const manifest = { format: "dp-beget-bridge-config-backup-v1", rootMode: rootInfo.mode & 0o777,
      createdAt: new Date().toISOString(), entries: records };
    await writeFile(path.join(output, "backup-manifest.json"), JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 });
    return manifest;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

async function main(args) {
  if (args.length !== 4 || args[0] !== "--config-root" || args[2] !== "--output-dir") {
    throw new Error("Usage: backup-config --config-root ABSOLUTE_DIRECTORY --output-dir NEW_DIRECTORY");
  }
  const result = await backupConfig({ configRoot: args[1], outputDir: args[3] });
  console.log(`Private configuration backup verified (${result.entries.length} entries)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Configuration backup failed (${error.code || "validation"})`);
    process.exitCode = 1;
  });
}

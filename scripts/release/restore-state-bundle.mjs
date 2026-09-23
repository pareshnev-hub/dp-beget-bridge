#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { restoreConfig, restoreSqliteSet } from "./restore-backup.mjs";
import { readRegularFile } from "./verify-artifact.mjs";

export async function restoreStateBundle({ backupDir, outputDir }) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to restore a state bundle");
  if (!path.isAbsolute(backupDir || "") || !path.isAbsolute(outputDir || "")) {
    throw new Error("Absolute backup and new restore directory paths are required");
  }
  const source = path.resolve(backupDir);
  const output = path.resolve(outputDir);
  const backupInfo = await stat(source);
  const outputParent = await stat(path.dirname(output));
  if (source === output || source.startsWith(`${output}${path.sep}`) || output.startsWith(`${source}${path.sep}`) ||
      (await realpath(source)) !== source || (await realpath(path.dirname(output))) !== path.dirname(output) ||
      !backupInfo.isDirectory() || backupInfo.uid !== 0 || (backupInfo.mode & 0o077) !== 0 ||
      !outputParent.isDirectory() || outputParent.uid !== 0 || (outputParent.mode & 0o022) !== 0) {
    throw new Error("Bundle backup and restore paths must be separate private real directories");
  }
  let manifest;
  try { manifest = JSON.parse(await readRegularFile(path.join(source, "bundle-manifest.json"), 16 * 1024)); }
  catch { throw new Error("Invalid state bundle manifest"); }
  if (manifest?.format !== "dp-beget-bridge-state-bundle-v2" ||
      !Number.isSafeInteger(manifest.configEntries) || manifest.configEntries < 0 ||
      !Array.isArray(manifest.databases) || manifest.databases.length === 0 ||
      manifest.databases.some(name => typeof name !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(name)) ||
      new Set(manifest.databases).size !== manifest.databases.length ||
      Object.keys(manifest.sources || {}).sort().join(",") !== "configRoot,databases" ||
      !path.isAbsolute(manifest.sources.configRoot || "") ||
      path.normalize(manifest.sources.configRoot) !== manifest.sources.configRoot ||
      !Array.isArray(manifest.sources.databases) ||
      manifest.sources.databases.length !== manifest.databases.length ||
      manifest.sources.databases.some((item, index) => !item ||
        Object.keys(item).sort().join(",") !== "name,path" ||
        item.name !== manifest.databases[index] || !path.isAbsolute(item.path || "") ||
        path.normalize(item.path) !== item.path) ||
      new Set(manifest.sources.databases.map(item => item.path)).size !== manifest.databases.length ||
      Object.keys(manifest.manifestSha256 || {}).sort().join(",") !== "config,sqlite") {
    throw new Error("Invalid state bundle manifest");
  }
  for (const name of ["config", "sqlite"]) {
    const expected = manifest.manifestSha256[name];
    if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected)) {
      throw new Error("Invalid state bundle checksum");
    }
    const bytes = await readRegularFile(path.join(source, name, "backup-manifest.json"), 64 * 1024);
    if (createHash("sha256").update(bytes).digest("hex") !== expected) {
      throw new Error("State bundle manifest checksum mismatch");
    }
  }
  await mkdir(output, { mode: 0o700 });
  try {
    const config = await restoreConfig({ backupDir: path.join(source, "config"), outputDir: path.join(output, "config") });
    const sqlite = await restoreSqliteSet({ backupDir: path.join(source, "sqlite"), outputDir: path.join(output, "sqlite") });
    if (config.entries !== manifest.configEntries ||
        sqlite.databases.join(",") !== manifest.databases.join(",")) {
      throw new Error("State bundle restored inventory differs from its manifest");
    }
    return { directory: output, databases: sqlite.databases, configEntries: config.entries,
      sources: manifest.sources };
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

async function main(args) {
  if (args.length !== 4 || args[0] !== "--backup-dir" || args[2] !== "--output-dir") {
    throw new Error("Usage: restore-state-bundle --backup-dir PRIVATE_STATE_BUNDLE --output-dir NEW_PRIVATE_RESTORE_DIRECTORY");
  }
  const result = await restoreStateBundle({ backupDir: args[1], outputDir: args[3] });
  console.log(`Verified grouped state restored into a new directory (${result.databases.length} databases)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`State bundle restore failed (${error.code || "validation"})`);
    process.exitCode = 1;
  });
}

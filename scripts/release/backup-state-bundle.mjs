#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { backupConfig } from "./backup-config.mjs";
import { backupSqliteSet } from "./backup-sqlite.mjs";
import { readRegularFile } from "./verify-artifact.mjs";

const exec = promisify(execFile);
const REQUIRED = ["dp-beget-session-host.service", "dp-beget-agent.service", "dp-beget-mcp.service"];
const OPTIONAL = ["dp-beget-mcp-oauth-spike.service", "dp-beget-tunnel.service"];

export async function assertBridgeWritersStopped() {
  for (const unit of [...REQUIRED, ...OPTIONAL]) {
    const { stdout } = await exec("systemctl", ["show", unit, "--property=LoadState,ActiveState", "--no-pager"],
      { timeout: 5000, maxBuffer: 4096 });
    const state = Object.fromEntries(stdout.trim().split("\n").map(line => {
      const at = line.indexOf("=");
      if (at < 1) throw new Error("Incomplete systemd state response");
      return [line.slice(0, at), line.slice(at + 1)];
    }));
    if (state.LoadState === "not-found" && OPTIONAL.includes(unit)) continue;
    if (state.LoadState !== "loaded" || state.ActiveState !== "inactive") {
      throw new Error(`${unit} must be stopped before a grouped state snapshot`);
    }
  }
}

async function syncTree(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, item.name);
    if (item.isDirectory()) await syncTree(filename);
    else if (item.isFile()) {
      const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await file.sync(); } finally { await file.close(); }
    } else throw new Error("Backup contains a link or special file");
  }
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function backupStateBundle({ configRoot, databases, outputDir,
  assertQuiesced = assertBridgeWritersStopped }) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to capture a state bundle");
  if (!path.isAbsolute(outputDir || "") || !Array.isArray(databases) || databases.length === 0) {
    throw new Error("Absolute new output directory and explicit database list are required");
  }
  const output = path.resolve(outputDir);
  const parent = path.dirname(output);
  if ((await realpath(parent)) !== parent || (await stat(parent)).uid !== 0 ||
      ((await stat(parent)).mode & 0o022) !== 0) {
    throw new Error("Backup parent must be a root-owned non-writable-by-others real directory");
  }
  if (!path.isAbsolute(configRoot || "") || path.normalize(configRoot) !== configRoot ||
      !Array.isArray(databases) || databases.some(item => !item ||
        !path.isAbsolute(item.source || "") || path.normalize(item.source) !== item.source) ||
      (await realpath(configRoot)) !== configRoot) {
    throw new Error("State bundle source paths must be real normalized absolute paths");
  }
  for (const item of databases) {
    if ((await realpath(item.source)) !== item.source) {
      throw new Error("State bundle database source cannot traverse a link");
    }
  }
  await assertQuiesced();
  await mkdir(output, { mode: 0o700 });
  try {
    const config = await backupConfig({ configRoot, outputDir: path.join(output, "config") });
    const sqlite = await backupSqliteSet({ databases, outputDir: path.join(output, "sqlite") });
    await assertQuiesced();
    const hashes = {};
    for (const name of ["config", "sqlite"]) {
      const bytes = await readRegularFile(path.join(output, name, "backup-manifest.json"), 64 * 1024);
      hashes[name] = createHash("sha256").update(bytes).digest("hex");
    }
    const manifest = { format: "dp-beget-bridge-state-bundle-v2", createdAt: new Date().toISOString(),
      configEntries: config.entries.length, databases: sqlite.databases.map(item => item.name),
      manifestSha256: hashes,
      sources: { configRoot, databases: databases.map(item => ({ name: item.name, path: item.source })) } };
    await writeFile(path.join(output, "bundle-manifest.json"), JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 });
    await syncTree(output);
    return manifest;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

async function main(args) {
  if (args.length < 6 || args[0] !== "--config-root" || args[2] !== "--output-dir" ||
      (args.length - 4) % 2 !== 0) {
    throw new Error("Usage: backup-state-bundle --config-root ABSOLUTE_DIR --output-dir NEW_PRIVATE_DIR --database LABEL=ABSOLUTE_SQLITE [--database ...]");
  }
  const databases = [];
  for (let i = 4; i < args.length; i += 2) {
    if (args[i] !== "--database" || !args[i + 1]?.includes("=")) throw new Error("Invalid --database argument");
    const at = args[i + 1].indexOf("=");
    databases.push({ name: args[i + 1].slice(0, at), source: args[i + 1].slice(at + 1) });
  }
  const result = await backupStateBundle({ configRoot: args[1], outputDir: args[3], databases });
  console.log(`Grouped private snapshot verified: ${result.databases.join(", ")} (${result.configEntries} config entries)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`State bundle failed (${error.code || "validation"})`);
    process.exitCode = 1;
  });
}

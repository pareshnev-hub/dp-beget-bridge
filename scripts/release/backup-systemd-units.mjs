#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readRegularFile } from "./verify-artifact.mjs";

const exec = promisify(execFile);
const UNITS = ["dp-beget-session-host.service", "dp-beget-agent.service",
  "dp-beget-mcp.service", "dp-beget-mcp-oauth-spike.service"];
const DEFAULT_UNIT_DIR = "/etc/systemd/system";
const MAX_UNIT_BYTES = 64 * 1024;

async function showUnit(unit) {
  const { stdout } = await exec("systemctl", ["show", unit,
    "--property=LoadState,FragmentPath,DropInPaths,WorkingDirectory,User", "--no-pager"],
  { timeout: 5000, maxBuffer: 4096 });
  return stdout;
}

function fields(stdout) {
  const result = {};
  for (const line of stdout.trim().split("\n")) {
    const at = line.indexOf("=");
    if (at < 1 || Object.hasOwn(result, line.slice(0, at))) throw new Error("Invalid systemd unit metadata");
    result[line.slice(0, at)] = line.slice(at + 1);
  }
  return result;
}

export async function backupSystemdUnits({ outputDir, unitDirectory = DEFAULT_UNIT_DIR, inspectUnit = showUnit }) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to snapshot systemd units");
  if (!path.isAbsolute(outputDir || "") || !path.isAbsolute(unitDirectory || "")) {
    throw new Error("Absolute systemd directory and new backup directory are required");
  }
  const root = path.resolve(unitDirectory);
  const output = path.resolve(outputDir);
  const parent = path.dirname(output);
  if ((await realpath(root)) !== root || (await stat(root)).uid !== 0 ||
      ((await stat(root)).mode & 0o022) !== 0 ||
      (await realpath(parent)) !== parent || (await stat(parent)).uid !== 0 ||
      ((await stat(parent)).mode & 0o022) !== 0 ||
      output === root || output.startsWith(`${root}${path.sep}`) || root.startsWith(`${output}${path.sep}`)) {
    throw new Error("Systemd source and backup must be separate root-owned real directories");
  }
  const records = [];
  const seen = new Set();
  for (const unit of UNITS) {
    const value = fields(await inspectUnit(unit));
    const expectedWorkdir = unit === "dp-beget-mcp-oauth-spike.service"
      ? "/opt/dp-beget-bridge-dp012-dcr" : "/opt/dp-beget-bridge";
    if (value.LoadState !== "loaded" || !value.User || value.User === "root" ||
        value.FragmentPath !== path.join(root, unit) ||
        typeof value.DropInPaths !== "string" || value.WorkingDirectory !== expectedWorkdir) {
      throw new Error(`${unit} does not match the supported migration layout`);
    }
    const dropins = value.DropInPaths ? value.DropInPaths.split(" ") : [];
    const dropinRoot = path.join(root, `${unit}.d`) + path.sep;
    if (dropins.some(item => !item.startsWith(dropinRoot) ||
        !/^[a-zA-Z0-9._-]+\.conf$/.test(item.slice(dropinRoot.length)))) {
      throw new Error(`${unit} has an unrecognized drop-in path`);
    }
    for (const filename of [value.FragmentPath, ...dropins]) {
      const relative = path.relative(root, filename).split(path.sep).join("/");
      if (seen.has(relative) || (await realpath(filename)) !== filename) {
        throw new Error("Systemd unit files must be distinct real paths");
      }
      seen.add(relative);
      const info = await lstat(filename);
      if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o022) !== 0) {
        throw new Error("Systemd unit file is not a root-owned regular file");
      }
      const bytes = await readRegularFile(filename, MAX_UNIT_BYTES);
      if (bytes.length !== info.size) throw new Error("Systemd unit changed during backup");
      records.push({ unit, path: relative, mode: info.mode & 0o777, uid: info.uid, gid: info.gid,
        size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), bytes });
    }
  }
  if (records.length > 32) throw new Error("Too many systemd drop-ins to back up safely");
  await mkdir(output, { mode: 0o700 });
  try {
    for (const record of records) {
      const target = path.join(output, "files", record.path);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, record.bytes, { flag: "wx", mode: 0o600 });
    }
    const manifest = { format: "dp-beget-bridge-unit-backup-v1", createdAt: new Date().toISOString(),
      files: records.map(({ bytes, ...item }) => item) };
    await writeFile(path.join(output, "backup-manifest.json"), JSON.stringify(manifest, null, 2) + "\n",
      { flag: "wx", mode: 0o600 });
    return manifest;
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}

async function main(args) {
  if (args.length !== 2 || args[0] !== "--output-dir") {
    throw new Error("Usage: backup-systemd-units --output-dir NEW_PRIVATE_BACKUP_DIRECTORY");
  }
  const report = await backupSystemdUnits({ outputDir: args[1] });
  console.log(`Private systemd unit snapshot contains ${report.files.length} verified files`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Systemd unit snapshot failed (${error.code || "validation"})`);
    process.exitCode = 1;
  });
}

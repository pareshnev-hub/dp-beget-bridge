#!/usr/bin/env node
import { execFile } from "node:child_process";
import { lstat, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const REQUIRED = ["dp-beget-session-host.service", "dp-beget-agent.service", "dp-beget-mcp.service"];
const OPTIONAL = ["dp-beget-mcp-oauth-spike.service", "dp-beget-tunnel.service"];
const PROPERTIES = ["LoadState", "ActiveState", "User", "WorkingDirectory", "KillMode"];
const VERSION_DIR = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-zA-Z0-9.-]+)?-[0-9a-f]{40}$/;

function parseProperties(output) {
  const result = {};
  for (const line of output.trim().split("\n")) {
    const split = line.indexOf("=");
    if (split < 1) throw new Error("Invalid systemd unit response");
    const key = line.slice(0, split);
    if (!PROPERTIES.includes(key) || Object.hasOwn(result, key)) throw new Error("Invalid systemd unit response");
    result[key] = line.slice(split + 1);
  }
  if (PROPERTIES.some(key => !Object.hasOwn(result, key))) throw new Error("Incomplete systemd unit response");
  return result;
}

async function systemctlShow(unit) {
  const { stdout } = await exec("systemctl", ["show", unit, `--property=${PROPERTIES.join(",")}`, "--no-pager"],
    { timeout: 5000, maxBuffer: 16 * 1024 });
  return stdout;
}

export async function inspectReleaseServices({ releaseRoot, showUnit = systemctlShow }) {
  if (!path.isAbsolute(releaseRoot || "") || (await realpath(releaseRoot)) !== path.resolve(releaseRoot) ||
      (await realpath(path.join(releaseRoot, "releases"))) !== path.join(path.resolve(releaseRoot), "releases")) {
    throw new Error("Version root and releases must be real absolute directories");
  }
  const current = path.join(releaseRoot, "current");
  if (!(await lstat(current)).isSymbolicLink()) throw new Error("Update requires a managed current release link");
  const target = await readlink(current);
  const versionDir = target.startsWith("releases/") ? target.slice("releases/".length) : "";
  if (!VERSION_DIR.test(versionDir) ||
      (await realpath(current)) !== path.join(releaseRoot, "releases", versionDir)) {
    throw new Error("Update requires a managed versioned current release");
  }
  const units = {};
  const users = {};
  const expected = path.join(releaseRoot, "current");
  for (const unit of [...REQUIRED, ...OPTIONAL]) {
    const value = parseProperties(await showUnit(unit));
    if (value.LoadState === "not-found" && OPTIONAL.includes(unit)) {
      units[unit] = "absent";
      continue;
    }
    if (value.LoadState !== "loaded" || !["active", "inactive"].includes(value.ActiveState)) {
      throw new Error(`${unit} is unavailable or in an unstable state`);
    }
    if (unit !== "dp-beget-tunnel.service") {
      if (value.WorkingDirectory !== expected || !value.User || value.User === "root") {
        throw new Error(`${unit} is not bound to the managed release and a non-root identity`);
      }
    }
    if (unit === REQUIRED[0] && value.KillMode !== "process") {
      throw new Error("Session Host must preserve tmux processes across restart");
    }
    units[unit] = value.ActiveState;
    users[unit] = value.User;
  }
  if (REQUIRED.some(unit => units[unit] !== "active")) throw new Error("All required services must be active before an update");
  const identities = REQUIRED.map(unit => users[unit]);
  if (new Set(identities).size !== identities.length) throw new Error("Required services must have separate identities");
  return { versionDir, units };
}

async function main(args) {
  if (args.length !== 2 || args[0] !== "--release-root") {
    throw new Error("Usage: service-preflight --release-root EXISTING_VERSIONED_ROOT");
  }
  const report = await inspectReleaseServices({ releaseRoot: args[1] });
  console.log(`Managed service update preflight passed for ${report.versionDir}`);
  for (const [unit, state] of Object.entries(report.units)) console.log(`${unit}: ${state}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Managed service update preflight failed (${error.code || "validation"})`);
    process.exitCode = 1;
  });
}

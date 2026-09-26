import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MANAGED_APP_UNITS, MANAGED_DROP_IN, managedUnitContent } from "./stage-managed-unit-overrides.mjs";
import { WRITER_GUARD_DROP_IN, WRITER_START_PERMIT, writerGuardContent } from "./writer-boot-guard.mjs";
import { PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";

const exec = promisify(execFile);
const UNIT_ROOT = "/etc/systemd/system";

async function systemctlShow(unit) {
  const { stdout } = await exec("systemctl", ["show", unit,
    "--property=LoadState,FragmentPath,DropInPaths,WorkingDirectory,User,KillMode", "--no-pager"],
  { timeout: 5000, maxBuffer: 4096 });
  return stdout;
}

function parse(output) {
  const keys = ["LoadState", "FragmentPath", "DropInPaths", "WorkingDirectory", "User", "KillMode"];
  const properties = {};
  for (const line of output.trim().split("\n")) {
    const at = line.indexOf("=");
    const key = line.slice(0, at);
    if (at < 1 || !keys.includes(key) || Object.hasOwn(properties, key)) {
      throw new Error("Invalid managed systemd unit response");
    }
    properties[key] = line.slice(at + 1);
  }
  if (keys.some(key => !Object.hasOwn(properties, key))) throw new Error("Incomplete managed systemd unit response");
  return properties;
}

export async function inspectInstalledManagedUnits({ unitDirectory = UNIT_ROOT, releaseRoot,
  marker = PERSISTENT_MARKER, permit = WRITER_START_PERMIT,
  showUnit = systemctlShow } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to verify managed systemd units");
  const expectedContent = managedUnitContent(releaseRoot);
  if (!path.isAbsolute(unitDirectory || "") || path.normalize(unitDirectory) !== unitDirectory ||
      (await realpath(unitDirectory)) !== unitDirectory) {
    throw new Error("Untrusted systemd unit root");
  }
  const rootInfo = await stat(unitDirectory);
  if (!rootInfo.isDirectory() || rootInfo.uid !== 0 || (rootInfo.mode & 0o022) !== 0) {
    throw new Error("Untrusted systemd unit root");
  }
  for (const unit of MANAGED_APP_UNITS) {
    const guard = path.join(unitDirectory, `${unit}.d`, WRITER_GUARD_DROP_IN);
    const guardInfo = await lstat(guard);
    if (!guardInfo.isFile() || guardInfo.nlink !== 1 || guardInfo.uid !== 0 ||
        (guardInfo.mode & 0o022) !== 0 || (await realpath(guard)) !== guard) {
      throw new Error(`Untrusted writer guard for ${unit}`);
    }
    const guardHandle = await open(guard, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await guardHandle.readFile("utf8")) !== writerGuardContent(marker, permit)) {
        throw new Error(`Changed writer guard for ${unit}`);
      }
    } finally { await guardHandle.close(); }
    const filename = path.join(unitDirectory, `${unit}.d`, MANAGED_DROP_IN);
    const info = await lstat(filename);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
        (await realpath(filename)) !== filename) throw new Error(`Untrusted managed drop-in for ${unit}`);
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await handle.readFile("utf8")) !== expectedContent) {
        throw new Error(`Changed managed drop-in for ${unit}`);
      }
    } finally { await handle.close(); }
    const state = parse(await showUnit(unit));
    const expectedDropins = unit === "dp-beget-mcp-oauth-spike.service"
      ? `${path.join(unitDirectory, `${unit}.d`, "10-dp012-dcr.conf")} ${guard} ${filename}`
      : `${guard} ${filename}`;
    if (state.LoadState !== "loaded" || state.FragmentPath !== path.join(unitDirectory, unit) ||
        state.DropInPaths !== expectedDropins ||
        state.WorkingDirectory !== path.join(releaseRoot, "current") ||
        !state.User || state.User === "root" ||
        (unit === "dp-beget-session-host.service" && state.KillMode !== "process")) {
      throw new Error(`Systemd has not loaded the managed service binding for ${unit}`);
    }
  }
  return { units: [...MANAGED_APP_UNITS], workingDirectory: path.join(releaseRoot, "current") };
}

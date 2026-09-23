import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";
import { MANAGED_APP_UNITS, MANAGED_DROP_IN } from "./stage-managed-unit-overrides.mjs";
import { WRITER_GUARD_DROP_IN, WRITER_START_PERMIT, writerGuardContent } from "./writer-boot-guard.mjs";

const exec = promisify(execFile);
const KEYS = ["LoadState", "FragmentPath", "DropInPaths"];

async function systemctlShow(unit) {
  const { stdout } = await exec("systemctl", ["show", unit,
    `--property=${KEYS.join(",")}`, "--no-pager"], { timeout: 5000, maxBuffer: 4096 });
  return stdout;
}

function parse(output) {
  const properties = {};
  for (const line of output.trim().split("\n")) {
    const at = line.indexOf("=");
    const key = line.slice(0, at);
    if (at < 1 || !KEYS.includes(key) || Object.hasOwn(properties, key)) {
      throw new Error("Unexpected systemd writer guard metadata");
    }
    properties[key] = line.slice(at + 1);
  }
  if (KEYS.some(key => !Object.hasOwn(properties, key))) throw new Error("Incomplete systemd writer guard metadata");
  return properties;
}

export async function inspectInstalledWriterGuards({ unitDirectory = "/etc/systemd/system",
  marker = PERSISTENT_MARKER, permit = WRITER_START_PERMIT, managed = false,
  showUnit = systemctlShow } = {}) {
  if (process.getuid?.() !== 0 || !path.isAbsolute(unitDirectory) ||
      path.normalize(unitDirectory) !== unitDirectory ||
      (await realpath(unitDirectory)) !== unitDirectory) throw new Error("Untrusted writer unit directory");
  const root = await stat(unitDirectory);
  if (!root.isDirectory() || root.uid !== 0 || (root.mode & 0o022) !== 0) {
    throw new Error("Untrusted writer unit directory");
  }
  const content = writerGuardContent(marker, permit);
  for (const unit of MANAGED_APP_UNITS) {
    const directory = path.join(unitDirectory, `${unit}.d`);
    const filename = path.join(directory, WRITER_GUARD_DROP_IN);
    const info = await lstat(filename);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
        (await realpath(filename)) !== filename) throw new Error(`Untrusted writer guard for ${unit}`);
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await handle.readFile("utf8")) !== content) throw new Error(`Changed writer guard for ${unit}`);
    } finally { await handle.close(); }
    const paths = [];
    if (unit === "dp-beget-mcp-oauth-spike.service") paths.push(path.join(directory, "10-dp012-dcr.conf"));
    paths.push(filename);
    if (managed) paths.push(path.join(directory, MANAGED_DROP_IN));
    const state = parse(await showUnit(unit));
    if (state.LoadState !== "loaded" || state.FragmentPath !== path.join(unitDirectory, unit) ||
        state.DropInPaths !== paths.join(" ")) {
      throw new Error(`Systemd has not loaded the exclusive writer guard for ${unit}`);
    }
  }
  return { guardedUnits: [...MANAGED_APP_UNITS], marker, permit };
}

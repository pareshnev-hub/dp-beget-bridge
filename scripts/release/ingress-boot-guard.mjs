#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const INGRESS_UNITS = Object.freeze([
  "dp-beget-oauth-proxy.socket",
  "dp-beget-oauth-proxy.service",
  "dp-beget-tunnel.service"
]);
const DROP_IN = "90-dp-r0004-migration-guard.conf";

// A marker under /run would disappear at reboot. Refuse it: this guard must survive power loss.
export const PERSISTENT_MARKER = "/var/lib/dp-beget-bridge/migration-incomplete";

export function guardContent(marker = PERSISTENT_MARKER) {
  if (!path.isAbsolute(marker) || marker.startsWith("/run/") || marker.startsWith("/tmp/") ||
      marker.startsWith("/dev/") || marker.startsWith("/proc/") || marker.startsWith("/sys/") ||
      marker.includes("\n") || marker.includes("\r") || marker.includes("%") ||
      path.normalize(marker) !== marker || marker.endsWith("/")) {
    throw new Error("Guard requires a normalized persistent absolute marker path");
  }
  return `[Unit]\nConditionPathExists=!${marker}\n`;
}

// Prepare inert drop-ins in a new private directory. Installation and daemon-reload are
// deliberately a separate journaled transaction, after the original units are snapshotted.
export async function stageIngressBootGuard({ outputDir, marker = PERSISTENT_MARKER }) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to stage an ingress guard");
  const content = guardContent(marker);
  if (!path.isAbsolute(outputDir || "") || path.resolve(outputDir) !== outputDir) {
    throw new Error("A normalized absolute output directory is required");
  }
  const parent = path.dirname(outputDir);
  const parentInfo = await stat(parent);
  if ((await realpath(parent)) !== parent || !parentInfo.isDirectory() || parentInfo.uid !== 0 ||
      (parentInfo.mode & 0o022) !== 0) throw new Error("Guard parent must be a trusted root directory");
  await mkdir(outputDir, { mode: 0o700 });
  for (const unit of INGRESS_UNITS) {
    const directory = path.join(outputDir, `${unit}.d`);
    await mkdir(directory, { mode: 0o700 });
    await writeFile(path.join(directory, DROP_IN), content, { flag: "wx", mode: 0o600 });
  }
  const handle = await open(outputDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
  return { marker, units: [...INGRESS_UNITS], dropIn: DROP_IN };
}

export async function assertIngressBootGuard({ unitDirectory, marker = PERSISTENT_MARKER }) {
  const expected = guardContent(marker);
  for (const unit of INGRESS_UNITS) {
    const filename = path.join(unitDirectory, `${unit}.d`, DROP_IN);
    const info = await lstat(filename);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
        (await realpath(filename)) !== filename) throw new Error(`Untrusted guard for ${unit}`);
    const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if ((await handle.readFile("utf8")) !== expected) throw new Error(`Unexpected guard for ${unit}`);
    } finally { await handle.close(); }
  }
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.error("Ingress guard must be installed by a journaled migration transaction");
  process.exitCode = 1;
}

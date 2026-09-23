#!/usr/bin/env node
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { assertIngressBootGuard, INGRESS_UNITS, PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";

const exec = promisify(execFile);
const DEFAULT_UNIT_DIRECTORY = "/etc/systemd/system";
const KEYS = ["LoadState", "FragmentPath", "DropInPaths"];

async function systemctlShow(unit) {
  const { stdout } = await exec("systemctl", ["show", unit,
    `--property=${KEYS.join(",")}`, "--no-pager"], { timeout: 5000, maxBuffer: 4096 });
  return stdout;
}

function parse(output) {
  const properties = {};
  for (const line of output.trim().split("\n")) {
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    if (separator < 1 || !KEYS.includes(key) || Object.hasOwn(properties, key)) {
      throw new Error("Unexpected systemd guard metadata");
    }
    properties[key] = line.slice(separator + 1);
  }
  if (KEYS.some(key => !Object.hasOwn(properties, key))) {
    throw new Error("Incomplete systemd guard metadata");
  }
  return properties;
}

// Call only after daemon-reload. DropInPaths proves the running manager loaded the
// exact on-disk guard; requiring it as the sole drop-in prevents a later override.
export async function inspectInstalledIngressGuard({ unitDirectory = DEFAULT_UNIT_DIRECTORY,
  marker = PERSISTENT_MARKER, showUnit = systemctlShow } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to verify installed ingress guards");
  if (!path.isAbsolute(unitDirectory) || path.resolve(unitDirectory) !== unitDirectory ||
      (await realpath(unitDirectory)) !== unitDirectory) throw new Error("Untrusted unit directory");
  const info = await stat(unitDirectory);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
    throw new Error("Untrusted unit directory");
  }
  await assertIngressBootGuard({ unitDirectory, marker });
  for (const unit of INGRESS_UNITS) {
    const value = parse(await showUnit(unit));
    const fragment = path.join(unitDirectory, unit);
    const guard = path.join(unitDirectory, `${unit}.d`, "90-dp-r0004-migration-guard.conf");
    if (value.LoadState !== "loaded" || value.FragmentPath !== fragment ||
        value.DropInPaths !== guard) throw new Error(`Systemd has not loaded the exclusive guard for ${unit}`);
  }
  return { guardedUnits: [...INGRESS_UNITS], marker };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  inspectInstalledIngressGuard().then(report => {
    console.log(`Loaded persistent ingress guard on ${report.guardedUnits.length} dedicated units`);
  }).catch(error => {
    console.error(`Installed ingress guard verification failed (${error.code || "validation"})`);
    process.exitCode = 1;
  });
}

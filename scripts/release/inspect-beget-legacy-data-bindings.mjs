#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const OAUTH_CODE_ROOT = "/opt/dp-beget-bridge-dp012-dcr";
const OAUTH_CONFIG_SHA256 = "02621a54095afaf18f028c1a561b39db296e871ccaf8c92d497ddb2479b5e9de";
class SafeBindingError extends Error {
  constructor(unit, stage) {
    super(`Legacy data binding check failed: ${/^[a-z0-9.-]{1,80}$/.test(unit) ? unit : "unknown-unit"}, ${stage}`);
  }
}
const EXPECTED = [
  { unit: "dp-beget-session-host.service", key: "DP_SESSION_DATA_DIR",
    directory: "/var/lib/dp-beget-bridge", filename: "state.sqlite" },
  { unit: "dp-beget-agent.service", key: "DP_DATA_DIR",
    directory: "/var/lib/dp-beget-bridge-agent", filename: "session-owners.sqlite" },
  { unit: "dp-beget-mcp-oauth-spike.service", key: "DP_AUTH_DATA_DIR",
    directory: "/var/lib/dp-beget-bridge-mcp/auth", filename: "auth.sqlite",
    mode: "oauth" }
];

async function showUnit(unit) {
  const { stdout } = await exec("systemctl", ["show", unit,
    "--property=LoadState,ActiveState,MainPID", "--no-pager"],
  { timeout: 5000, maxBuffer: 4096 });
  const properties = Object.create(null);
  for (const line of stdout.trim().split("\n")) {
    const index = line.indexOf("=");
    const key = line.slice(0, index);
    if (index < 1 || !["LoadState", "ActiveState", "MainPID"].includes(key) ||
        Object.hasOwn(properties, key)) throw new Error("Incomplete service identity");
    properties[key] = line.slice(index + 1);
  }
  if (Object.keys(properties).length !== 3 || properties.LoadState !== "loaded" ||
      properties.ActiveState !== "active" || !/^[1-9][0-9]*$/.test(properties.MainPID)) {
    throw new Error("Legacy service is not an active loaded process");
  }
  return properties.MainPID;
}

// Read the process environment without ever returning or formatting unrelated
// fields. Never log errors from the reader: an injected error may contain data.
function selectFields(bytes, names) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 256 * 1024 ||
      bytes.at(-1) !== 0) throw new Error("Process environment cannot be inspected safely");
  const selected = Object.create(null);
  for (const field of names) {
    const prefix = Buffer.from(`${field}=`);
    let start = 0;
    while (start < bytes.length) {
      const end = bytes.indexOf(0, start);
      if (end < 0) throw new Error("Process environment is incomplete");
      if (end - start >= prefix.length && bytes.subarray(start, start + prefix.length).equals(prefix)) {
        if (Object.hasOwn(selected, field)) throw new Error("Duplicated service data binding");
        selected[field] = bytes.toString("utf8", start + prefix.length, end);
      }
      start = end + 1;
    }
  }
  return selected;
}

export async function inspectBegetLegacyDataBindings({ show = showUnit,
  readEnvironment = pid => readFile(`/proc/${pid}/environ`),
  inspectFile = lstat, resolvePath = realpath, listDirectory = readdir,
  processCwd = pid => realpath(`/proc/${pid}/cwd`),
  readOAuthConfig = () => readFile(path.join(OAUTH_CODE_ROOT, "apps/mcp/src/config.js")),
  oauthCodeRoot = OAUTH_CODE_ROOT, oauthConfigSha256 = OAUTH_CONFIG_SHA256,
  expected = EXPECTED, requireRoot = () => process.getuid?.() === 0 } = {}) {
  if (!requireRoot()) throw new Error("Root is required for a live service data-binding proof");
  const records = [];
  for (const { unit, key, directory, filename, mode } of expected) {
    let stage = "service-state";
    try {
      const pid = await show(unit);
      stage = "environment-inspection";
      let bytes;
      let fields;
      try {
        bytes = await readEnvironment(pid);
        fields = selectFields(bytes, [key, ...(mode ? ["DP_MCP_AUTH_MODE"] : [])]);
      } catch { throw new Error("Service data binding cannot be inspected safely"); }
      finally { if (Buffer.isBuffer(bytes)) bytes.fill(0); }
      if (mode) {
        stage = "oauth-code-identity";
        // The deployed OAuth unit does not set DP_AUTH_DATA_DIR: its pinned
        // config.js supplies this default. Bind that default to the actual
        // running process cwd and the exact observed source fingerprint.
        const source = await readOAuthConfig();
        if ((await processCwd(pid)) !== oauthCodeRoot ||
            createHash("sha256").update(source).digest("hex") !== oauthConfigSha256) {
          throw new Error("OAuth process code identity changed");
        }
      }
      stage = "data-directory";
      const boundDirectory = fields[key] ?? (mode ? directory : undefined);
      if (boundDirectory !== directory || (mode && fields.DP_MCP_AUTH_MODE !== mode) ||
          !path.isAbsolute(directory) || (await resolvePath(directory)) !== directory) {
        throw new Error("Legacy service uses an unexpected state directory or mode");
      }
      stage = "database-file";
      const info = await inspectFile(path.join(directory, filename));
      if (!info.isFile() || info.nlink !== 1 || !Number.isSafeInteger(info.size) || info.size < 0 ||
          (await resolvePath(path.join(directory, filename))) !== path.join(directory, filename)) {
        throw new Error("Legacy service database is missing or unsafe");
      }
      const allowed = new Set([filename, `${filename}-wal`, `${filename}-shm`, `${filename}-journal`]);
      if (filename === "state.sqlite") for (const version of [0, 1]) {
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
          allowed.add(`state.sqlite.backup-v${version}${suffix}`);
        }
      }
      if (mode === "oauth" && filename === "auth.sqlite") {
        // Observed retained v1 backup from the legacy OAuth schema migration.
        allowed.add("auth.sqlite.backup-v1");
      }
      stage = "sqlite-inventory";
      const names = await listDirectory(directory);
      if (!Array.isArray(names) || names.some(name =>
        /\.(?:sqlite|sqlite3|db|db3)(?:$|[.-])/.test(name) && !allowed.has(name))) {
        throw new Error("Uninventoried SQLite state in legacy service directory");
      }
      for (const name of names.filter(name => /\.(?:sqlite|sqlite3|db|db3)(?:$|[.-])/.test(name))) {
        const file = await inspectFile(path.join(directory, name));
        if (!file.isFile() || file.nlink !== 1) throw new Error("Unsafe SQLite file in legacy directory");
      }
      stage = "service-stability";
      if (await show(unit) !== pid) throw new Error("Legacy service restarted during data inventory");
      records.push({ unit, database: path.join(directory, filename), size: info.size });
    } catch { throw new SafeBindingError(unit, stage); }
  }
  return { databases: records, scope: "three pinned live process data bindings; no admission drain proof" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error("Usage: node scripts/release/inspect-beget-legacy-data-bindings.mjs");
    process.exitCode = 1;
  } else inspectBegetLegacyDataBindings().then(result => {
    console.log(JSON.stringify(result));
  }).catch(error => {
    console.error(error instanceof SafeBindingError ? error.message :
      "Legacy service data-binding proof failed; no environment values printed");
    process.exitCode = 1;
  });
}

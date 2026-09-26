import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertSessionHostRestartSafe } from "../deploy/session-host-restart-preflight.mjs";
import { inspectBegetLegacyDataBindings } from "./inspect-beget-legacy-data-bindings.mjs";
import { inspectLegacyServiceActivity } from "./legacy-service-activity.mjs";
import { probeLegacyLocalHealth } from "./probe-legacy-health.mjs";
import { LEGACY_COUNTER_HOTFIX_FILES } from "./stage-legacy-counter-hotfix.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const absolute = value => typeof value === "string" && path.isAbsolute(value) &&
  path.normalize(value) === value;

async function trustedDirectory(directory, privateMode = false) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== 0 || info.gid !== 0 ||
      (info.mode & (privateMode ? 0o7777 : 0o002)) !== (privateMode ? 0o700 : 0) ||
      await realpath(directory) !== directory) {
    throw new Error("Untrusted staged hotfix directory");
  }
}

async function pinnedBytes(filename, sha, mode) {
  const before = await lstat(filename);
  if (!before.isFile() || before.nlink !== 1 || before.uid !== 0 || before.gid !== 0 ||
      (before.mode & 0o7777) !== mode || before.size > 512 * 1024 ||
      await realpath(filename) !== filename) throw new Error("Untrusted hotfix file");
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (current.dev !== before.dev || current.ino !== before.ino ||
        current.size !== before.size || current.nlink !== 1) throw new Error("Hotfix file changed");
    const bytes = await handle.readFile();
    if (bytes.length !== before.size || digest(bytes) !== sha) throw new Error("Hotfix digest changed");
  } finally { await handle.close(); }
}

// Reopen the staged four-file hotfix and check the active R0003 boundary in
// one read-only pass. This deliberately does not approve service restarts or
// attest that existing HTTP requests have drained.
export async function preflightLegacyCounterHotfix({ stageDir, manifestSha256,
  files = LEGACY_COUNTER_HOTFIX_FILES,
  inspectServices = inspectLegacyServiceActivity,
  inspectBindings = inspectBegetLegacyDataBindings,
  readHealth = probeLegacyLocalHealth,
  assertRestartSafe = assertSessionHostRestartSafe,
  ledgerPath = "/var/lib/dp-beget-bridge/state.sqlite" } = {}) {
  if (process.getuid?.() !== 0 || !absolute(stageDir) ||
      !/^[0-9a-f]{64}$/.test(manifestSha256 || "") || files.length !== 4 ||
      !absolute(ledgerPath)) throw new Error("Root, private stage and manifest digest required");
  await trustedDirectory(path.dirname(stageDir));
  await trustedDirectory(stageDir, true);
  const entries = await readdir(stageDir);
  const expectedNames = ["manifest.json", ...files.flatMap(item =>
    [`${item.name}.before.js`, `${item.name}.after.js`])].sort();
  if (JSON.stringify(entries.sort()) !== JSON.stringify(expectedNames)) {
    throw new Error("Staged hotfix inventory changed");
  }
  const manifestPath = path.join(stageDir, "manifest.json");
  await pinnedBytes(manifestPath, manifestSha256, 0o600);
  const manifestHandle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let manifest;
  try { manifest = JSON.parse((await manifestHandle.readFile()).toString("utf8")); }
  finally { await manifestHandle.close(); }
  const expected = files.map(item => ({ name: item.name,
    source: path.join(item.root, item.relative), before: item.before, after: item.after, mode: 0o664 }));
  if (manifest?.format !== "dp-r0003-counter-hotfix-v1" ||
      JSON.stringify(manifest.files) !== JSON.stringify(expected)) {
    throw new Error("Staged hotfix manifest does not match the pinned R0003 files");
  }
  for (const record of expected) {
    await pinnedBytes(path.join(stageDir, `${record.name}.before.js`), record.before, 0o600);
    await pinnedBytes(path.join(stageDir, `${record.name}.after.js`), record.after, 0o600);
    await pinnedBytes(record.source, record.before, record.mode);
  }
  const activity = await inspectServices();
  for (const unit of ["dp-beget-session-host.service", "dp-beget-agent.service",
    "dp-beget-mcp.service", "dp-beget-mcp-oauth-spike.service",
    "dp-beget-oauth-proxy.socket", "dp-beget-tunnel.service"]) {
    if (activity?.[unit] !== "active") throw new Error(`Legacy unit is not active: ${unit}`);
  }
  const bindings = await inspectBindings();
  if (bindings?.databases?.length !== 3 || !bindings.databases.some(item =>
    item.unit === "dp-beget-session-host.service" && item.database === ledgerPath)) {
    throw new Error("Legacy data binding changed");
  }
  const restart = assertRestartSafe(ledgerPath);
  if (restart?.activeOperationCount !== 0) throw new Error("Legacy operations remain active");
  const health = await readHealth();
  if (health?.services !== 4 || !Array.isArray(health.products) ||
      health.products.length !== 4 || Object.hasOwn(health, "inFlightRequests")) {
    throw new Error("Legacy health no longer matches the original R0003 release");
  }
  for (const record of expected) await pinnedBytes(record.source, record.before, record.mode);
  await pinnedBytes(manifestPath, manifestSha256, 0o600);
  return { stageDir, manifestSha256, files: expected.length,
    activeOperations: 0, scope: "read-only R0003 hotfix readiness; no in-flight request or restart proof" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) {
    console.error("Usage: node preflight-legacy-counter-hotfix.mjs ABSOLUTE_STAGE_DIR MANIFEST_SHA256");
    process.exitCode = 1;
  } else preflightLegacyCounterHotfix({ stageDir: process.argv[2],
    manifestSha256: process.argv[3] }).then(result => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error("Legacy counter hotfix readiness failed; no live files changed");
      process.exitCode = 1;
    });
}

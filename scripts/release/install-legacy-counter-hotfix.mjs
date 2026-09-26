import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { assertSessionHostRestartSafe } from "../deploy/session-host-restart-preflight.mjs";
import { inspectBegetOAuthRouteBoundary } from "./inspect-beget-oauth-route-boundary.mjs";
import { LEGACY_COUNTER_HOTFIX_FILES } from "./stage-legacy-counter-hotfix.mjs";
import { preflightLegacyCounterHotfix, verifyLegacyCounterHotfixStage } from
  "./preflight-legacy-counter-hotfix.mjs";
import { probeBegetClosedOAuthRoute } from "./probe-beget-closed-oauth-route.mjs";
import { probeBegetLegacyOAuthRoute } from "./probe-beget-legacy-oauth-route.mjs";
import { probeLegacyLocalHealth } from "./probe-legacy-health.mjs";

const exec = promisify(execFile);
const ENTRY = ["dp-beget-oauth-proxy.socket", "dp-beget-tunnel.service"];
const WRITERS = ["dp-beget-mcp-oauth-spike.service", "dp-beget-mcp.service",
  "dp-beget-agent.service", "dp-beget-session-host.service"];
const START = [...WRITERS].reverse();
const LEDGER = "/var/lib/dp-beget-bridge/state.sqlite";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

async function systemctl(verb, unit) {
  await exec("systemctl", [verb, unit], { timeout: 25000, maxBuffer: 4096 });
}
async function show(unit) {
  const { stdout } = await exec("systemctl", ["show", unit,
    "--property=ActiveState,MainPID,KillMode", "--no-pager"],
  { timeout: 5000, maxBuffer: 4096 });
  return parseLegacyUnitState(stdout, unit);
}
export function parseLegacyUnitState(stdout, unit) {
  const socket = unit === "dp-beget-oauth-proxy.socket";
  const expected = socket ? ["ActiveState", "KillMode"] :
    ["ActiveState", "MainPID", "KillMode"];
  const result = {};
  for (const line of stdout.trim().split("\n")) {
    const at = line.indexOf("=");
    const key = line.slice(0, at);
    if (at < 1 || !expected.includes(key) ||
        Object.hasOwn(result, key)) throw new Error("Unexpected systemd unit metadata");
    result[key] = line.slice(at + 1);
  }
  if (Object.keys(result).length !== expected.length) {
    throw new Error("Incomplete systemd unit metadata");
  }
  return result;
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function journalUpdate(filename, record, phase) {
  record.phase = phase;
  const parent = path.dirname(filename);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL |
    constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, filename);
  await syncDirectory(parent);
}

async function journalCreate(filename, stageDir, manifestSha256) {
  const handle = await open(filename, constants.O_CREAT | constants.O_EXCL |
    constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  const record = { format: "dp-r0003-counter-hotfix-install-v1", stageDir,
    manifestSha256, phase: "preparing" };
  try { await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(path.dirname(filename));
  return record;
}

async function journalRead(filename, stageDir, manifestSha256) {
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || info.gid !== 0 ||
      (info.mode & 0o7777) !== 0o600 || info.size > 4096 ||
      await realpath(filename) !== filename) throw new Error("Untrusted hotfix journal");
  const record = JSON.parse(await readFile(filename, "utf8"));
  if (record?.format !== "dp-r0003-counter-hotfix-install-v1" ||
      record.stageDir !== stageDir || record.manifestSha256 !== manifestSha256 ||
      !["preparing", "closing-ingress", "ingress-closed", "stopping-writers",
        "writers-stopped", "sources-updated", "locally-healthy", "opening-ingress",
        "complete", "recovering", "recovered"].includes(record.phase) ||
      Object.keys(record).sort().join(",") !== "format,manifestSha256,phase,stageDir") {
    throw new Error("Unrecognized hotfix activation journal");
  }
  return record;
}

async function pinnedLive(filename, expectedHash, expectedMode) {
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || info.gid !== 0 ||
      (info.mode & 0o7777) !== expectedMode || info.size > 512 * 1024 ||
      await realpath(filename) !== filename ||
      sha256(await readFile(filename)) !== expectedHash) {
    throw new Error("Live hotfix source changed");
  }
}

async function replaceSource({ source, staged, from, to, mode }) {
  await pinnedLive(source, from.sha, from.mode);
  const bytes = await readFile(staged);
  if (sha256(bytes) !== to.sha) throw new Error("Staged hotfix bytes changed");
  const parent = path.dirname(source);
  const info = await lstat(parent);
  if (!info.isDirectory() || info.uid !== 0 || info.gid !== 0 ||
      (info.mode & 0o002) !== 0 || await realpath(parent) !== parent) {
    throw new Error("Untrusted live source directory");
  }
  const temporary = path.join(parent, `.dp-r0003-counter-${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL |
    constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  try {
    await chmod(temporary, mode);
    const persisted = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await persisted.sync(); } finally { await persisted.close(); }
    await pinnedLive(source, from.sha, from.mode);
    await rename(temporary, source);
    await syncDirectory(parent);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await pinnedLive(source, to.sha, mode);
}

// After the dedicated proxy and private tunnel are stopped, zero established
// connections plus the durable Session Host ledger are a bounded maintenance
// window check. This is not the migration's later instrumented drain proof.
export function countLegacyConnections(tcp, unix) {
  if (typeof tcp !== "string" || typeof unix !== "string") throw new Error("Missing socket inventory");
  let count = 0;
  for (const line of tcp.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || !["ESTAB", "CLOSE-WAIT", "FIN-WAIT-1", "FIN-WAIT-2",
      "LAST-ACK", "SYN-RECV", "SYN-SENT", "CLOSING", "LISTEN", "TIME-WAIT"].includes(parts[0])) {
      throw new Error("Unknown TCP socket inventory");
    }
    if (["LISTEN", "TIME-WAIT"].includes(parts[0])) continue;
    if ([parts[3], parts[4]].some(address =>
      /:(?:8787|8788|8789|8791)$/.test(address))) count++;
  }
  for (const line of unix.split("\n")) {
    if (!line.trim()) continue;
    if (line.includes("/run/dp-beget-bridge/session-host.sock")) count++;
  }
  return count;
}
async function inspectConnections() {
  const options = { timeout: 5000, maxBuffer: 512 * 1024 };
  const tcp = (await exec("ss", ["-Htan"], options)).stdout;
  const unix = (await exec("ss", ["-Hxan", "state", "connected"], options)).stdout;
  return countLegacyConnections(tcp, unix);
}
async function waitIdle({ connections = inspectConnections,
  checkLedger = assertSessionHostRestartSafe, sleep = delay, attempts = 40 } = {}) {
  let consecutive = 0;
  for (let i = 0; i < attempts; i++) {
    const idle = await connections() === 0 &&
      checkLedger(LEDGER).activeOperationCount === 0;
    consecutive = idle ? consecutive + 1 : 0;
    if (consecutive >= 2) return;
    await sleep(1000);
  }
  throw new Error("Legacy connections or operations did not drain within the maintenance window");
}

async function stopped(unit, systemctlShow) {
  const state = await systemctlShow(unit);
  if (state.ActiveState !== "inactive" ||
      (!unit.endsWith(".socket") && state.MainPID !== "0")) {
    throw new Error(`Legacy unit did not stop: ${unit}`);
  }
}
async function running(unit, systemctlShow) {
  const state = await systemctlShow(unit);
  if (state.ActiveState !== "active" || !/^[1-9][0-9]*$/.test(state.MainPID)) {
    throw new Error(`Legacy unit did not start: ${unit}`);
  }
}

async function active(unit, systemctlShow) {
  const state = await systemctlShow(unit);
  if (state.ActiveState !== "active") throw new Error(`Legacy ingress did not start: ${unit}`);
}
async function waitHealth(readHealth, { counters, sleep = delay } = {}) {
  let last;
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const result = await readHealth(counters ? { requireCounters: true } : {});
      if (result?.services === 4 && result.products?.length === 4 &&
          (counters ? result.inFlightRequests?.length === 4 &&
            result.inFlightRequests.every(value => value === 0) :
            !Object.hasOwn(result, "inFlightRequests"))) return result;
    } catch (error) { last = error; }
    await sleep(1000);
  }
  throw new Error(`R0003 ${counters ? "counter" : "original"} health failed: ${last?.message || "unexpected response"}`);
}

// Explicit crash recovery is also called after a failed in-process install.
// Only pre-exposure code bytes are restored; no database or transcript is
// rewound. If recovery fails, the journal remains and the caller must inspect
// it before retrying. A second run of --install can never skip this journal.
export async function recoverLegacyCounterHotfix({ stageDir, manifestSha256,
  verifyStage = verifyLegacyCounterHotfixStage,
  stop = unit => systemctl("stop", unit), start = unit => systemctl("start", unit),
  systemctlShow = show, drain = waitIdle, readHealth = probeLegacyLocalHealth,
  replace = replaceSource, publicOriginal = probeBegetLegacyOAuthRoute,
  checkLedger = assertSessionHostRestartSafe,
  files = LEGACY_COUNTER_HOTFIX_FILES } = {}) {
  if (process.getuid?.() !== 0 || !path.isAbsolute(stageDir || "") ||
      path.normalize(stageDir) !== stageDir || !/^[0-9a-f]{64}$/.test(manifestSha256 || "")) {
    throw new Error("Root and exact hotfix stage required for recovery");
  }
  await verifyStage({ stageDir, manifestSha256, files });
  const journalPath = `${stageDir}.activation.json`;
  const journal = await journalRead(journalPath, stageDir, manifestSha256);
  if (journal.phase === "complete" || journal.phase === "recovered") {
    throw new Error("Hotfix transaction already reached a terminal phase");
  }
  await journalUpdate(journalPath, journal, "recovering");
  for (const unit of ENTRY) {
    await stop(unit);
    await stopped(unit, systemctlShow);
  }
  await drain();
  await stop("dp-beget-oauth-proxy.service");
  await stopped("dp-beget-oauth-proxy.service", systemctlShow);
  for (const unit of WRITERS) {
    if ((await systemctlShow(unit)).ActiveState === "active") {
      if (unit === "dp-beget-session-host.service") checkLedger(LEDGER);
      await stop(unit);
    }
    await stopped(unit, systemctlShow);
  }
  for (const item of files) {
    const source = path.join(item.root, item.relative);
    try { await pinnedLive(source, item.before, 0o664); continue; }
    catch { await pinnedLive(source, item.after, 0o644); }
    await replace({ source, staged: path.join(stageDir, `${item.name}.before.js`),
      from: { sha: item.after, mode: 0o644 },
      to: { sha: item.before, mode: 0o664 }, mode: 0o664 });
  }
  for (const unit of START) {
    await start(unit);
    await running(unit, systemctlShow);
  }
  await waitHealth(readHealth, { counters: false });
  await journalUpdate(journalPath, journal, "opening-ingress");
  for (const unit of ENTRY) {
    await start(unit);
    await active(unit, systemctlShow);
  }
  await publicOriginal();
  await journalUpdate(journalPath, journal, "recovered");
  return { stageDir, journalPath, phase: "recovered" };
}

// Only the four reviewed R0003 handlers are replaced. All saved originals
// remain private and immutable. On failure, ingress stays closed until a
// separate recovery action verifies the mixed state and reopens it.
export async function installLegacyCounterHotfix({ stageDir, manifestSha256,
  preflight = preflightLegacyCounterHotfix,
  inspectRoute = inspectBegetOAuthRouteBoundary,
  publicOriginal = probeBegetLegacyOAuthRoute,
  publicClosed = probeBegetClosedOAuthRoute,
  stop = unit => systemctl("stop", unit), start = unit => systemctl("start", unit),
  systemctlShow = show, drain = waitIdle, readHealth = probeLegacyLocalHealth,
  replace = replaceSource, checkLedger = assertSessionHostRestartSafe,
  verifyStage = verifyLegacyCounterHotfixStage,
  files = LEGACY_COUNTER_HOTFIX_FILES } = {}) {
  if (process.getuid?.() !== 0 || !path.isAbsolute(stageDir || "") ||
      path.normalize(stageDir) !== stageDir || !/^[0-9a-f]{64}$/.test(manifestSha256 || "")) {
    throw new Error("Root and exact private hotfix stage are required");
  }
  await preflight({ stageDir, manifestSha256 });
  await inspectRoute();
  await publicOriginal();
  if ((await systemctlShow("dp-beget-session-host.service")).KillMode !== "process") {
    throw new Error("Session Host would kill persistent terminal sessions");
  }
  const journalPath = `${stageDir}.activation.json`;
  const journal = await journalCreate(journalPath, stageDir, manifestSha256);
  try {
  await journalUpdate(journalPath, journal, "closing-ingress");
  for (const unit of ENTRY) await stop(unit);
  for (const unit of ENTRY) await stopped(unit, systemctlShow);
  await publicClosed();
  await journalUpdate(journalPath, journal, "ingress-closed");
  await drain();
  await stop("dp-beget-oauth-proxy.service");
  await stopped("dp-beget-oauth-proxy.service", systemctlShow);
  await journalUpdate(journalPath, journal, "stopping-writers");
  for (const unit of WRITERS) {
    if (unit === "dp-beget-session-host.service") checkLedger(LEDGER);
    await stop(unit);
    await stopped(unit, systemctlShow);
  }
  await journalUpdate(journalPath, journal, "writers-stopped");
  for (const item of files) {
    const source = path.join(item.root, item.relative);
    await replace({ source, staged: path.join(stageDir, `${item.name}.after.js`),
      from: { sha: item.before, mode: 0o664 },
      to: { sha: item.after, mode: 0o644 }, mode: 0o644 });
  }
  await journalUpdate(journalPath, journal, "sources-updated");
  for (const unit of START) {
    await start(unit);
    await running(unit, systemctlShow);
  }
  await waitHealth(readHealth, { counters: true });
  await journalUpdate(journalPath, journal, "locally-healthy");
  await inspectRoute();
  for (const unit of ENTRY) {
    await start(unit);
    await active(unit, systemctlShow);
  }
  await publicOriginal();
  await journalUpdate(journalPath, journal, "complete");
  return { stageDir, manifestSha256, journalPath, phase: "complete",
    scope: "counter-only R0003 handler hotfix; not an R0004 migration" };
  } catch (failure) {
    try {
      await recoverLegacyCounterHotfix({ stageDir, manifestSha256,
        stop, start, systemctlShow, drain, readHealth, replace, publicOriginal,
        checkLedger, verifyStage, files });
    } catch (recovery) {
      throw new AggregateError([failure, recovery],
        "Hotfix installation and recovery failed; inspect the activation journal");
    }
    throw new Error(`Hotfix installation failed and original R0003 was recovered: ${failure.message}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5 || !["--install", "--recover"].includes(process.argv[2])) {
    console.error("Usage: node install-legacy-counter-hotfix.mjs --install|--recover ABSOLUTE_STAGE_DIR MANIFEST_SHA256");
    process.exitCode = 1;
  } else (process.argv[2] === "--install" ? installLegacyCounterHotfix :
    recoverLegacyCounterHotfix)({ stageDir: process.argv[3],
    manifestSha256: process.argv[4] }).then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(`Hotfix activation stopped: ${error.message}. Check the durable activation journal before recovery.`);
      process.exitCode = 1;
    });
}

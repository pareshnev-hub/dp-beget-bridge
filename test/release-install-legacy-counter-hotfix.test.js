import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { countLegacyConnections, installLegacyCounterHotfix, recoverLegacyCounterHotfix,
  parseLegacyUnitState } from
  "../scripts/release/install-legacy-counter-hotfix.mjs";
import { stageLegacyCounterHotfix } from "../scripts/release/stage-legacy-counter-hotfix.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const INGRESS = ["dp-beget-oauth-proxy.socket", "dp-beget-oauth-proxy.service",
  "dp-beget-tunnel.service"];
const WRITERS = ["dp-beget-mcp-oauth-spike.service", "dp-beget-mcp.service",
  "dp-beget-agent.service", "dp-beget-session-host.service"];

async function fixture(t, failStart = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-r0003-counter-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const live = path.join(root, "live");
  const candidate = path.join(root, "candidate");
  await mkdir(live);
  await mkdir(candidate);
  const files = [];
  for (const name of ["agent", "base-mcp", "session-host", "oauth-mcp"]) {
    const relative = `${name}/server.js`;
    const before = Buffer.from(`original-${name}\n`);
    const after = Buffer.from(`counter-${name}\n`);
    for (const [directory, bytes] of [[live, before], [candidate, after]]) {
      const filename = path.join(directory, relative);
      await mkdir(path.dirname(filename));
      await writeFile(filename, bytes);
      await chmod(filename, directory === live ? 0o664 : 0o644);
    }
    files.push({ root: live, name, relative, before: digest(before), after: digest(after) });
  }
  const stageDir = path.join(root, "stage");
  const { manifestSha256 } = await stageLegacyCounterHotfix({
    outputDir: stageDir, candidateRoot: candidate, files });
  const states = new Map([...INGRESS, ...WRITERS].map((unit, index) =>
    [unit, { ActiveState: "active", MainPID: unit.endsWith(".socket") ? "0" : String(900 + index),
      KillMode: unit === "dp-beget-session-host.service" ? "process" : "control-group" }]));
  let failed = false;
  const options = { stageDir, manifestSha256, files,
    preflight: async () => ({}), inspectRoute: async () => ({}),
    publicOriginal: async () => assert.equal(states.get(INGRESS[0]).ActiveState, "active"),
    publicClosed: async () => assert.equal(states.get(INGRESS[0]).ActiveState, "inactive"),
    systemctlShow: async unit => states.get(unit),
    checkLedger: () => ({ activeOperationCount: 0 }),
    drain: async () => assert.equal(states.get(INGRESS[0]).ActiveState, "inactive"),
    stop: async unit => { const state = states.get(unit); state.ActiveState = "inactive"; state.MainPID = "0"; },
    start: async unit => {
      if (failStart && !failed && unit === "dp-beget-session-host.service") {
        failed = true; throw new Error("injected startup failure");
      }
      const state = states.get(unit);
      state.ActiveState = "active";
      state.MainPID = unit.endsWith(".socket") ? "0" : "1111";
    },
    readHealth: async ({ requireCounters } = {}) => ({ services: 4,
      products: ["bridge", "bridge", "bridge", "host"],
      ...(requireCounters ? { inFlightRequests: [0, 0, 0, 0] } : {}) }) };
  return { options, files, stageDir, states };
}

test("TCP and session socket inventory counts possible active clients", () => {
  const tcp = "ESTAB 0 0 127.0.0.1:8787 127.0.0.1:43002\n" +
    "ESTAB 0 0 127.0.0.1:45001 127.0.0.1:8789\n";
  const unix = "u_str ESTAB 0 0 /run/dp-beget-bridge/session-host.sock 123 * 124\n";
  assert.equal(countLegacyConnections(tcp, unix), 3);
  assert.equal(countLegacyConnections("", ""), 0);
  assert.throws(() => countLegacyConnections("UNKNOWN", ""), /Unknown TCP/);
});

test("systemd socket has no MainPID property in the observed Beget output", () => {
  assert.deepEqual(parseLegacyUnitState("KillMode=control-group\nActiveState=active\n",
    "dp-beget-oauth-proxy.socket"),
  { KillMode: "control-group", ActiveState: "active" });
  assert.throws(() => parseLegacyUnitState("ActiveState=active\n",
    "dp-beget-mcp.service"), /Incomplete systemd/);
});

test("hotfix activates reviewed bytes and leaves an exact durable journal", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { options, files, stageDir, states } = await fixture(t);
  const report = await installLegacyCounterHotfix(options);
  assert.equal(report.phase, "complete");
  for (const item of files) {
    assert.equal(digest(await readFile(path.join(item.root, item.relative))), item.after);
  }
  assert.equal(states.get(INGRESS[0]).ActiveState, "active");
  const journal = JSON.parse(await readFile(`${stageDir}.activation.json`, "utf8"));
  assert.equal(journal.phase, "complete");
});

test("failed startup restores all original bytes before ingress reopens", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { options, files, stageDir, states } = await fixture(t, true);
  await assert.rejects(installLegacyCounterHotfix(options), /original R0003 was recovered/);
  for (const item of files) {
    assert.equal(digest(await readFile(path.join(item.root, item.relative))), item.before);
  }
  assert.equal(states.get(INGRESS[0]).ActiveState, "active");
  const journal = JSON.parse(await readFile(`${stageDir}.activation.json`, "utf8"));
  assert.equal(journal.phase, "recovered");
});

test("crash recovery accepts a mixed four-source state and restores original code", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { options, files, stageDir, states } = await fixture(t);
  const first = files[0];
  const source = path.join(first.root, first.relative);
  await writeFile(source, await readFile(path.join(stageDir, `${first.name}.after.js`)));
  await chmod(source, 0o644);
  await writeFile(`${stageDir}.activation.json`, JSON.stringify({
    format: "dp-r0003-counter-hotfix-install-v1", stageDir,
    manifestSha256: options.manifestSha256, phase: "writers-stopped" }) + "\n",
  { mode: 0o600 });
  const report = await recoverLegacyCounterHotfix(options);
  assert.equal(report.phase, "recovered");
  for (const item of files) {
    assert.equal(digest(await readFile(path.join(item.root, item.relative))), item.before);
  }
  assert.equal(states.get(INGRESS[0]).ActiveState, "active");
  await assert.rejects(recoverLegacyCounterHotfix(options), /terminal phase/);
});

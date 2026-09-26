import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { advanceMigrationJournal, readMigrationJournal, startMigrationJournal } from "../scripts/release/migration-journal.mjs";
import { runFirstMigration } from "../scripts/release/run-first-migration.mjs";
import { begetFirstMigrationProofs } from "../scripts/release/beget-first-migration-proofs.mjs";
import { legacyActivityFixture, unitBackupFixture } from "./fixtures/unit-backup.js";

const oldCommit = "a".repeat(40);
const newCommit = "b".repeat(40);
const artifactSha256 = "c".repeat(64);
const versionDir = `0.1.0-${newCommit}`;
const bindings = [
  { unit: "dp-beget-session-host.service", database: "/var/lib/dp-beget-bridge/state.sqlite", size: 1 },
  { unit: "dp-beget-agent.service", database: "/var/lib/dp-beget-bridge-agent/session-owners.sqlite", size: 1 },
  { unit: "dp-beget-mcp-oauth-spike.service", database: "/var/lib/dp-beget-bridge-mcp/auth/auth.sqlite", size: 1 }
];

async function setup(t) {
  const { root, backupDir } = await unitBackupFixture(t);
  const journalPath = path.join(root, "migration.json");
  await startMigrationJournal(journalPath, { oldCommit, newCommit, artifactSha256,
    unitBackupDir: backupDir, inspectServices: legacyActivityFixture });
  const releaseRoot = path.join(root, "releases-root");
  const args = { journalPath, workspace: root, releaseRoot, stagedIngress: root,
    stagedWriters: root, stagedManaged: root, unitDirectory: root, configRoot: root,
    snapshotDir: path.join(root, "snapshot"), assertRouteExclusive: async () => true,
    assertNoInFlight: async () => true, preflight: async () => ({ bindings: { databases: bindings } }),
    promote: async () => ({ sha256: artifactSha256, versionDir,
      directory: path.join(releaseRoot, "releases", versionDir) }) };
  return args;
}

function phases(args, log, failAt) {
  return Object.fromEntries([
    ["installGuards", "prepared", "guarded"], ["closeIngress", "guarded", "ingress-closed"],
    ["quiesce", "ingress-closed", "quiesced"], ["snapshot", "quiesced", "snapshotted"],
    ["installManaged", "snapshotted", "switched"], ["activate", "switched", "locally-healthy"],
    ["openIngress", "locally-healthy", "ingress-open"]
  ].map(([name, from, to]) => [name, async options => {
    log.push(name);
    if (name === "snapshot") assert.deepEqual(options.databases, [
      { name: "session-host", source: bindings[0].database },
      { name: "agent", source: bindings[1].database },
      { name: "oauth", source: bindings[2].database }
    ]);
    if (name === "quiesce") {
      assert.equal(options.stateDatabase, bindings[0].database);
      await options.assertNoInFlight();
    }
    if (name === failAt) throw new Error("injected boundary failure");
    await advanceMigrationJournal(args.journalPath, from, to, to === "snapshotted"
      ? { snapshotPath: args.snapshotDir, snapshotSha256: "d".repeat(64) } : {});
    if (name === "openIngress") await advanceMigrationJournal(args.journalPath, "ingress-open", "completed");
  }]));
}

test("first migration runs ordered, journaled steps with live-bound SQLite sources", {
  skip: process.getuid?.() !== 0
}, async t => {
  const args = await setup(t);
  const log = [];
  const result = await runFirstMigration({ ...args, ...phases(args, log) });
  assert.equal(result.phase, "completed");
  assert.equal(result.versionDir, versionDir);
  assert.deepEqual(log, ["installGuards", "closeIngress", "quiesce", "snapshot",
    "installManaged", "activate", "openIngress"]);
  assert.equal((await readMigrationJournal(args.journalPath)).phase, "completed");
});

test("Beget route and counter proofs stay bound to the ingress-closed journal", {
  skip: process.getuid?.() !== 0
}, async t => {
  const args = await setup(t);
  const calls = [];
  const phaseActions = phases(args, calls);
  const proofs = begetFirstMigrationProofs({ journalPath: args.journalPath,
    marker: path.join(args.workspace, "ingress-closed.marker"),
    route: async () => { calls.push("route"); return true; },
    drain: async ({ journalPath, marker, assertRouteExclusive }) => {
      assert.equal(journalPath, args.journalPath);
      assert.equal(marker, path.join(args.workspace, "ingress-closed.marker"));
      assert.equal((await readMigrationJournal(journalPath)).phase, "ingress-closed");
      calls.push("drain");
      return await assertRouteExclusive();
    } });
  const closeIngress = async options => {
    assert.equal(await options.assertRouteExclusive(), true);
    await phaseActions.closeIngress(options);
    assert.equal(await options.assertRouteExclusive(), true);
  };
  const openIngress = async options => {
    assert.equal(await options.assertRouteExclusive(), true);
    await phaseActions.openIngress(options);
  };
  assert.equal((await runFirstMigration({ ...args, ...proofs,
    ...phaseActions, closeIngress, openIngress })).phase, "completed");
  assert.deepEqual(calls.filter(value => value === "route"),
    ["route", "route", "route", "route"]);
  assert.equal(calls.indexOf("drain") > calls.indexOf("closeIngress"), true);
  assert.equal(calls.indexOf("snapshot") > calls.indexOf("drain"), true);
});

test("first migration refuses missing proofs and changed bindings before installing guards", {
  skip: process.getuid?.() !== 0
}, async t => {
  const args = await setup(t);
  const log = [];
  await assert.rejects(runFirstMigration({ ...args, assertRouteExclusive: undefined,
    ...phases(args, log) }), /independent ingress\/drain proofs/);
  await assert.rejects(runFirstMigration({ ...args, preflight: async () => ({ bindings: {
    databases: [bindings[0], bindings[1], { ...bindings[2], database: "/tmp/other.sqlite" }]
  } }), ...phases(args, log) }), /database bindings/);
  assert.deepEqual(log, []);
  assert.equal((await readMigrationJournal(args.journalPath)).phase, "prepared");
});

test("first migration retains the journal at a failed boundary and never opens ingress", {
  skip: process.getuid?.() !== 0
}, async t => {
  const args = await setup(t);
  const log = [];
  await assert.rejects(runFirstMigration({ ...args, ...phases(args, log, "snapshot") }),
    /injected boundary failure/);
  assert.equal((await readMigrationJournal(args.journalPath)).phase, "quiesced");
  assert.deepEqual(log, ["installGuards", "closeIngress", "quiesce", "snapshot"]);
  await assert.rejects(runFirstMigration({ ...args, ...phases(args, log) }), /inspect recovery first/);
});

test("an unsuccessful drain proof keeps the snapshot and switch out of reach", {
  skip: process.getuid?.() !== 0
}, async t => {
  const args = await setup(t);
  const log = [];
  await assert.rejects(runFirstMigration({ ...args, assertNoInFlight: async () => undefined,
    ...phases(args, log) }), /drain proof did not succeed/);
  assert.equal((await readMigrationJournal(args.journalPath)).phase, "ingress-closed");
  assert.deepEqual(log, ["installGuards", "closeIngress", "quiesce"]);
});

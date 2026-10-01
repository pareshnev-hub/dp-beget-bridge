import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installCleanPrivateRuntime } from "../scripts/release/install-clean-private-runtime.mjs";

const names = ["identities", "config", "units", "data", "release-root", "promotion", "pointer", "systemd", "admission"];
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-private-controller-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journalPath = path.join(root, "journal.json");
  const inputs = { journalPath, workspace: path.join(root, "candidate"), releaseRoot: path.join(root, "version-root"),
    manifestSha256: "a".repeat(64), trustDir: path.join(root, "trust") };
  const journal = { format: "dp-beget-clean-install-journal-v1", ...inputs, phase: "prepared",
    transactionId: "00000000-0000-4000-8000-000000000001", artifactSha256: "b".repeat(64),
    commit: "c".repeat(40), version: "0.1.0", identityPlan: { domain: "bridge.example.com" } };
  delete journal.journalPath; delete journal.trustDir;
  const save = record => writeFile(journalPath, JSON.stringify(record), { mode: 0o600 });
  const read = async () => JSON.parse(await readFile(journalPath, "utf8"));
  const calls = [];
  const advance = async transition => {
    const current = await read();
    assert.equal(transition.transactionId, journal.transactionId);
    assert.equal(transition.expectedPhase, current.phase);
    const next = { ...current, phase: transition.nextPhase };
    await save(next); return next;
  };
  const args = { ...inputs, isRoot: () => true,
    startJournal: async () => { await writeFile(journalPath, JSON.stringify(journal), { mode: 0o600, flag: "wx" }); return journal; },
    readJournal: read, advance, inspectTargets: async () => { calls.push("preflight"); },
    inspectSystemd: async () => ({ localSystemd: "inactive-bound" }), inspectPaused: async () => ({ paused: true }),
    installers: Object.fromEntries(names.map(name => [name, async input => {
      calls.push(name);
      await input.advance({ journalPath, transactionId: journal.transactionId,
        expectedPhase: `${name}-intent`, nextPhase: `${name}-ready` });
    }])) };
  return { args, calls, read, save, journal };
}

function withOwner(f) {
  const profile = { authMode: "oauth", ownerId: "owner-ci", executionProfile: "files-read" };
  f.args.initializeOwner = true;
  f.args.inspectAuthProfile = async () => ({ ...profile });
  f.args.inspectOwner = async () => ({ owner: "candidate-bound", ownerId: profile.ownerId });
  f.args.installers.owner = async input => {
    f.calls.push("owner");
    await input.advance({ journalPath: f.args.journalPath, transactionId: f.journal.transactionId,
      expectedPhase: "owner-intent", nextPhase: "owner-ready" });
  };
  return profile;
}

test("OPS-01: explicit OAuth composition commits owner readiness while keeping services inactive and admission paused", async t => {
  const f = await fixture(t);
  withOwner(f);
  const result = await installCleanPrivateRuntime(f.args);
  assert.equal(result.phase, "owner-ready");
  assert.equal(result.owner, "candidate-bound");
  assert.equal(result.authMode, "oauth");
  assert.equal(result.localServices, "inactive");
  assert.equal(result.admission, "paused");
  assert.equal(result.publicIngress, "unproven");
  assert.deepEqual(f.calls, ["preflight", ...names, "owner"]);
  await assert.rejects(installCleanPrivateRuntime(f.args), /fresh journal/);
});

test("OPS-01: incompatible or unverifiable OAuth selection stops before journal and all live mutations", async t => {
  for (const selection of ["static", "unverifiable", "invalid-option"]) {
    const f = await fixture(t);
    withOwner(f);
    if (selection === "static") f.args.inspectAuthProfile = async () => ({ authMode: "static" });
    if (selection === "unverifiable") f.args.inspectAuthProfile = async () => { throw new Error("signed candidate changed"); };
    if (selection === "invalid-option") f.args.initializeOwner = "yes";
    await assert.rejects(installCleanPrivateRuntime(f.args));
    await assert.rejects(f.read(), { code: "ENOENT" });
    assert.deepEqual(f.calls, []);
  }
});

test("OPS-01: owner interruption, phase skipping and missing commits retain intent without replay", async t => {
  for (const failure of ["interrupted", "skip", "missing-commit"]) {
    const f = await fixture(t);
    withOwner(f);
    f.args.installers.owner = async input => {
      f.calls.push("owner");
      if (failure === "interrupted") throw new Error("owner bootstrap interrupted");
      if (failure === "skip") await input.advance({ journalPath: f.args.journalPath,
        transactionId: f.journal.transactionId, expectedPhase: "owner-intent", nextPhase: "startup-ready" });
    };
    await assert.rejects(installCleanPrivateRuntime(f.args), /stopped during owner/);
    assert.equal((await f.read()).phase, "owner-intent");
    await assert.rejects(installCleanPrivateRuntime(f.args), /fresh journal/);
    assert.deepEqual(f.calls, ["preflight", ...names, "owner"]);
  }
});

test("OPS-01: owner readiness cannot count as controller success after profile drift or failed owner proof", async t => {
  for (const failure of ["profile-drift", "unproven-owner"]) {
    const f = await fixture(t);
    const profile = withOwner(f);
    if (failure === "profile-drift") {
      let reads = 0;
      f.args.inspectAuthProfile = async () => ++reads === 1 ? profile : { ...profile, ownerId: "owner-foreign" };
    } else f.args.inspectOwner = async () => ({ owner: "unproven" });
    await assert.rejects(installCleanPrivateRuntime(f.args), /stopped during final-verification/);
    assert.equal((await f.read()).phase, "owner-ready");
    await assert.rejects(installCleanPrivateRuntime(f.args), /fresh journal/);
  }
});

test("OPS-01: controller reaches only inactive paused installation and refuses replay", async t => {
  const f = await fixture(t);
  const result = await installCleanPrivateRuntime(f.args);
  assert.equal(result.phase, "admission-ready");
  assert.equal(result.localServices, "inactive");
  assert.equal(result.admission, "paused");
  assert.equal(result.publicIngress, "unproven");
  assert.deepEqual(f.calls, ["preflight", ...names]);
  assert.equal((await f.read()).phase, "admission-ready");
  await assert.rejects(installCleanPrivateRuntime(f.args), /fresh journal/);
  assert.deepEqual(f.calls, ["preflight", ...names]);
});

test("OPS-01: interrupted mutation retains its intent and cannot run subsequent phases or auto-retry", async t => {
  const f = await fixture(t);
  f.args.installers.config = async () => { f.calls.push("config"); throw new Error("interrupted after private copy"); };
  await assert.rejects(installCleanPrivateRuntime(f.args), error =>
    error.code === "CLEAN_PRIVATE_INSTALL_STOPPED" && error.cause.message === "interrupted after private copy");
  assert.equal((await f.read()).phase, "config-intent");
  assert.deepEqual(f.calls, ["preflight", "identities", "config"]);
  await assert.rejects(installCleanPrivateRuntime(f.args), /fresh journal/);
  assert.equal((await f.read()).phase, "config-intent");
});

test("OPS-01: signed identity drift and phase skipping stop the controller before another mutation", async t => {
  for (const scenario of ["identity", "skip", "missing-commit"]) {
    const f = await fixture(t);
    f.args.installers.config = async input => {
      f.calls.push("config");
      if (scenario === "skip") return input.advance({ journalPath: f.args.journalPath,
        transactionId: f.journal.transactionId, expectedPhase: "config-intent", nextPhase: "startup-ready" });
      if (scenario === "missing-commit") return;
      await input.advance({ journalPath: f.args.journalPath, transactionId: f.journal.transactionId,
        expectedPhase: "config-intent", nextPhase: "config-ready" });
      await f.save({ ...await f.read(), commit: "d".repeat(40) });
    };
    await assert.rejects(installCleanPrivateRuntime(f.args), /stopped during config/);
    assert.deepEqual(f.calls, ["preflight", "identities", "config"]);
  }
});

test("OPS-01: occupied targets, active final services and missing pause cannot count as completion", async t => {
  for (const scenario of ["occupied", "active", "unpaused"]) {
    const f = await fixture(t);
    if (scenario === "occupied") f.args.inspectTargets = async () => { throw new Error("occupied"); };
    if (scenario === "active") f.args.inspectSystemd = async () => ({ localSystemd: "active-bound" });
    if (scenario === "unpaused") f.args.inspectPaused = async () => ({ paused: false });
    await assert.rejects(installCleanPrivateRuntime(f.args), /journal retained/);
    assert.equal((await f.read()).phase, scenario === "occupied" ? "prepared" : "admission-ready");
    assert.ok(!f.calls.includes("startup"));
  }
  const f = await fixture(t);
  await assert.rejects(installCleanPrivateRuntime({ ...f.args, isRoot: () => false }), /Root/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(installCleanPrivateRuntime({ ...f.args, installers: { startup: () => {} } }), /Invalid/);
  assert.deepEqual(f.calls, []);
});

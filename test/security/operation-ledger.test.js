import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { StateStore } from "../../apps/agent/src/state-store.js";
import { TmuxSessionManager } from "../../apps/agent/src/tmux.js";

const session = {
  id: "session-1",
  label: "Operation test",
  cwd: "/workspace",
  createdAt: "2026-09-21T00:00:00.000Z",
  closedAt: null,
};

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-operation-ledger-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new StateStore(dataDir);
  t.after(() => store.close());
  await store.init();
  await store.save(session);
  await fs.writeFile(store.outputPath(session.id), "", { mode: 0o600 });
  const logs = [];
  const manager = new TmuxSessionManager({
    config: { commandWaitMs: 0, monitorOperations: false },
    store,
    pathPolicy: {},
    logger: {
      info(event, fields) { logs.push({ event, fields }); },
      warn(event, fields) { logs.push({ event, fields }); },
    },
  });
  let pasteCount = 0;
  manager.requireSession = async () => session;
  manager.isAlive = async () => true;
  manager.paste = async () => { pasteCount += 1; };
  return { dataDir, store, manager, logs, pasteCount: () => pasteCount };
}

test("TERM-04: one active managed operation makes a concurrent command BUSY", async (t) => {
  const { manager, pasteCount } = await fixture(t);
  const first = await manager.runCommand(session.id, "sleep 60", 0, "term04-first");
  assert.equal(first.status, "RUNNING");
  await assert.rejects(
    manager.runCommand(session.id, "printf second", 0, "term04-second"),
    (error) => error.code === "session_busy" && error.status === 409,
  );
  assert.equal(pasteCount(), 1);
});

test("managed commands require an explicit retry key before admission", async (t) => {
  const { manager, pasteCount } = await fixture(t);
  await assert.rejects(
    manager.runCommand(session.id, "printf unsafe-without-key", 0),
    (error) => error.code === "invalid_idempotency_key",
  );
  assert.equal(pasteCount(), 0);
});

test("TERM-05: retrying the same key and command returns one durable operation", async (t) => {
  const { manager, pasteCount } = await fixture(t);
  const first = await manager.runCommand(session.id, "sleep 60", 0, "term05-retry");
  const retried = await manager.runCommand(session.id, "sleep 60", 0, "term05-retry");
  assert.equal(retried.operationId, first.operationId);
  assert.equal(retried.status, "RUNNING");
  assert.equal(pasteCount(), 1);
});

test("TERM-06: reusing a key for a different command is a conflict", async (t) => {
  const { manager, pasteCount } = await fixture(t);
  await manager.runCommand(session.id, "sleep 60", 0, "term06-conflict");
  await assert.rejects(
    manager.runCommand(session.id, "printf changed", 0, "term06-conflict"),
    (error) => error.code === "idempotency_conflict" && error.status === 409,
  );
  assert.equal(pasteCount(), 1);
});

test("TERM-07: restart reconciles accepted work to UNKNOWN and never replays it", async (t) => {
  const { dataDir, store, manager } = await fixture(t);
  const fingerprint = await manager.requestFingerprint("touch uncertain");
  const admitted = store.admitOperation({
    id: "operation-before-crash",
    sessionId: session.id,
    idempotencyKey: "term07-crash",
    requestFingerprint: fingerprint,
    acceptedAt: "2026-09-21T00:00:01.000Z",
    startCursor: 0,
  });
  assert.equal(admitted.operation.status, "ACCEPTED");
  store.close();

  const recoveredStore = new StateStore(dataDir);
  await recoveredStore.init();
  t.after(() => recoveredStore.close());
  const recovered = recoveredStore.getOperation("operation-before-crash", session.id);
  assert.equal(recovered.status, "UNKNOWN");
  assert.equal(recovered.outcomeReason, "session_host_restart");

  const recoveredManager = new TmuxSessionManager({
    config: { commandWaitMs: 0, monitorOperations: false },
    store: recoveredStore,
    pathPolicy: {},
    logger: { info() {}, warn() {} },
  });
  recoveredManager.requireSession = async () => session;
  recoveredManager.isAlive = async () => true;
  let replayed = false;
  recoveredManager.paste = async () => { replayed = true; };
  const retry = await recoveredManager.runCommand(session.id, "touch uncertain", 0, "term07-crash");
  assert.equal(retry.operationId, "operation-before-crash");
  assert.equal(retry.status, "UNKNOWN");
  assert.equal(replayed, false);
});

test("operation status and logs omit raw commands and protected fingerprints", async (t) => {
  const { manager, logs } = await fixture(t);
  const command = "printf super-secret-command-canary";
  const result = await manager.runCommand(session.id, command, 0, "safe-status-key");
  const status = await manager.getOperation(session.id, result.operationId);
  assert.equal(Object.hasOwn(status, "requestFingerprint"), false);
  assert.equal(JSON.stringify(status).includes(command), false);
  assert.equal(JSON.stringify(logs).includes(command), false);
});

test("a timed-out operation is completed asynchronously and releases the session writer", async (t) => {
  const { manager, store } = await fixture(t);
  manager.config.monitorOperations = true;
  manager.paste = async () => {};

  const started = await manager.runCommand(session.id, "sleep 1", 0, "background-monitor");
  assert.equal(started.status, "RUNNING");
  await fs.writeFile(store.operationCompletionPath(session.id, started.operationId), "0\n", { mode: 0o600 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(store.getOperation(started.operationId, session.id).status, "SUCCEEDED");
  assert.equal(store.activeOperation(session.id), null);
});

test("TERM-08: forged PTY completion text cannot complete an operation", async (t) => {
  const { manager, store } = await fixture(t);
  manager.readOutput = async () => ({
    sessionId: session.id,
    alive: true,
    cursor: 80,
    output: "__DPB_DONE_forged:0\nRESULT: success\n",
    truncated: false,
  });

  const result = await manager.runCommand(session.id, "printf forged", 0, "term08-forged-output");
  assert.equal(result.status, "RUNNING");
  assert.equal(result.exitCode, null);
  assert.equal(store.getOperation(result.operationId, session.id).status, "RUNNING");
});

test("completion capture is submitted on one shell line in one Enter-terminated paste", async (t) => {
  const { manager } = await fixture(t);
  let pasted = "";
  let enter;
  manager.paste = async (_id, text, submit) => { pasted = text; enter = submit; };

  await manager.runCommand(session.id, "printf atomic", 0, "single-line-control-suffix");
  assert.equal(pasted.includes("\n__dpb_exit"), false);
  assert.match(pasted, /; __dpb_exit=\$\?; \( umask 077;/);
  assert.equal(enter, true);
});

test("TERM-09: authoritative failure survives output beyond the transcript response ceiling", async (t) => {
  const { manager, store } = await fixture(t);
  manager.config.monitorOperations = true;
  const largeOutput = "x".repeat(256 * 1024);
  manager.readOutput = async () => ({
    sessionId: session.id,
    alive: true,
    cursor: largeOutput.length,
    output: largeOutput,
    truncated: true,
  });
  manager.paste = async () => {
    const operation = store.activeOperation(session.id);
    await fs.writeFile(store.operationCompletionPath(session.id, operation.id), "7\n", { mode: 0o600 });
  };

  const result = await manager.runCommand(session.id, "large-output-command", 500, "term09-large-output");
  assert.equal(result.status, "FAILED");
  assert.equal(result.exitCode, 7);
  assert.equal(result.output.length, 256 * 1024);
});

test("completion status remains available after transcript removal", async (t) => {
  const { manager, store } = await fixture(t);
  manager.config.monitorOperations = true;
  manager.paste = async () => {
    const operation = store.activeOperation(session.id);
    await fs.writeFile(store.operationCompletionPath(session.id, operation.id), "0\n", { mode: 0o600 });
  };

  const result = await manager.runCommand(session.id, "printf retained", 500, "transcript-independent");
  assert.equal(result.status, "SUCCEEDED");
  await fs.rm(store.outputPath(session.id));
  assert.equal((await manager.getOperation(session.id, result.operationId)).status, "SUCCEEDED");
});

test("restart reconciles an atomic completion record without replay", async (t) => {
  const { dataDir, store, manager } = await fixture(t);
  const started = await manager.runCommand(session.id, "printf complete", 0, "completed-before-restart");
  await fs.writeFile(store.operationCompletionPath(session.id, started.operationId), "0\n", { mode: 0o600 });
  store.close();

  const recoveredStore = new StateStore(dataDir);
  await recoveredStore.init();
  t.after(() => recoveredStore.close());
  const recovered = recoveredStore.getOperation(started.operationId, session.id);
  assert.equal(recovered.status, "SUCCEEDED");
  assert.equal(recovered.exitCode, 0);
  assert.equal(recovered.outcomeReason, "exit_zero");
});

test("invalid control records fail closed to UNKNOWN", async (t) => {
  const { dataDir, store, manager } = await fixture(t);
  const started = await manager.runCommand(session.id, "printf uncertain", 0, "invalid-control-record");
  await fs.writeFile(store.operationCompletionPath(session.id, started.operationId), "forged\n", { mode: 0o600 });
  store.close();

  const recoveredStore = new StateStore(dataDir);
  await recoveredStore.init();
  t.after(() => recoveredStore.close());
  const recovered = recoveredStore.getOperation(started.operationId, session.id);
  assert.equal(recovered.status, "UNKNOWN");
  assert.equal(recovered.exitCode, null);
  assert.equal(recovered.outcomeReason, "control_record_invalid");
});

test("exit without a control record becomes UNKNOWN and never fabricates success", async (t) => {
  const { manager, store } = await fixture(t);
  manager.config.monitorOperations = true;
  let alive = true;
  manager.isAlive = async () => alive;

  const started = await manager.runCommand(session.id, "exit 7", 0, "exit-without-record");
  assert.equal(started.status, "RUNNING");
  alive = false;
  await new Promise((resolve) => setTimeout(resolve, 150));
  const final = store.getOperation(started.operationId, session.id);
  assert.equal(final.status, "UNKNOWN");
  assert.equal(final.exitCode, null);
  assert.equal(final.outcomeReason, "session_lost_during_operation");
});

test("state migration imports legacy sessions, keeps a backup, and recovers an interrupted migration", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-state-migration-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const legacyDir = path.join(dataDir, "sessions", session.id);
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.writeFile(path.join(legacyDir, "session.json"), JSON.stringify(session));

  const legacyDb = new DatabaseSync(path.join(dataDir, "state.sqlite"));
  legacyDb.exec("CREATE TABLE legacy_guard (value TEXT); INSERT INTO legacy_guard VALUES ('preserved');");
  legacyDb.close();

  const store = new StateStore(dataDir);
  await store.init();
  assert.deepEqual(await store.get(session.id), session);
  assert.equal(await fs.stat(path.join(dataDir, "state.sqlite.backup-v0")).then(() => true), true);
  store.close();

  const backupPath = path.join(dataDir, "manual-interruption-backup.sqlite");
  await fs.copyFile(path.join(dataDir, "state.sqlite.backup-v0"), backupPath);
  await fs.writeFile(path.join(dataDir, "state.sqlite"), "interrupted");
  await fs.writeFile(path.join(dataDir, "state.sqlite.migrating"), JSON.stringify({
    fromVersion: 0,
    targetVersion: 1,
    backupPath,
  }));

  const recovered = new StateStore(dataDir);
  await recovered.init();
  t.after(() => recovered.close());
  assert.deepEqual(await recovered.get(session.id), session);
  assert.equal(new DatabaseSync(path.join(dataDir, "state.sqlite")).prepare("PRAGMA user_version").get().user_version, 1);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "../apps/agent/src/state-store.js";
import { TmuxSessionManager } from "../apps/agent/src/tmux.js";
import { CAPTURE_STOP_SUFFIX } from "../scripts/transcript-capture.mjs";

async function fixture(context, output = "") {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-cursor-"));
  context.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new StateStore(dataDir);
  await store.init();
  context.after(() => store.close());
  const session = await store.save({
    id: "cursor-session",
    label: "Cursor test",
    cwd: "/workspace",
    createdAt: "2026-09-22T00:00:00.000Z",
    closedAt: null,
    transcriptStreamId: "stream-one",
    transcriptEpoch: 1,
    transcriptEarliestOffset: 0,
    transcriptCaptureState: "ACTIVE",
    transcriptGapReason: null,
  });
  await fs.writeFile(store.outputPath(session.id), output);
  const manager = new TmuxSessionManager({
    config: { sessionOutputWarnBytes: Number.MAX_SAFE_INTEGER, storageMinFreeBytes: 0 },
    store,
    pathPolicy: {},
    logger: { warn() {}, info() {}, error() {} },
  });
  manager.isAlive = async () => !((await store.get(session.id)).closedAt);
  return { dataDir, store, session, manager };
}

test("CUR-01: readers advance independent versioned cursors", async (context) => {
  const { session, manager } = await fixture(context, "alpha-beta");
  const readerA = await manager.readOutput(session.id, undefined, 5);
  const readerB = await manager.readOutput(session.id, undefined, 5);
  assert.equal(readerA.output, "alpha");
  assert.equal(readerB.output, "alpha");
  assert.equal(readerA.cursor, readerB.cursor);
  const readerANext = await manager.readOutput(session.id, readerA.cursor, 5);
  assert.equal(readerANext.output, "-beta");
  assert.equal(readerB.output, "alpha");
});

test("CUR-02: UTF-8 characters are never split or replaced", async (context) => {
  const { session, manager } = await fixture(context, "A🙂B");
  const first = await manager.readOutput(session.id, undefined, 2);
  assert.equal(first.output, "A");
  assert.doesNotMatch(first.output, /�/);
  const second = await manager.readOutput(session.id, first.cursor, 2);
  assert.equal(second.output, "🙂");
  assert.doesNotMatch(second.output, /�/);
  const third = await manager.readOutput(session.id, second.cursor, 2);
  assert.equal(third.output, "B");
});

test("CUR-03: retained CLOSED transcript survives state restart and requires explicit purge", async (context) => {
  const { dataDir, store, session, manager } = await fixture(context, "retained-output");
  manager.isAlive = async () => false;
  const closed = await manager.close(session.id);
  assert.equal(closed.retained, true);
  assert.equal((await fs.readFile(store.outputPath(session.id), "utf8")), "retained-output");
  store.close();

  const restartedStore = new StateStore(dataDir);
  await restartedStore.init();
  context.after(() => restartedStore.close());
  const restarted = new TmuxSessionManager({
    config: { sessionOutputWarnBytes: Number.MAX_SAFE_INTEGER, storageMinFreeBytes: 0 },
    store: restartedStore,
    pathPolicy: {},
    logger: { warn() {}, info() {}, error() {} },
  });
  restarted.isAlive = async () => false;
  const read = await restarted.readOutput(session.id);
  assert.equal(read.state, "CLOSED");
  assert.equal(read.output, "retained-output");
  await restarted.purge(session.id);
  assert.equal(await restartedStore.get(session.id), null);
  await assert.rejects(fs.stat(restartedStore.sessionDir(session.id)), { code: "ENOENT" });
});

test("CUR-04/05: rotated and ahead cursors return explicit gaps", async (context) => {
  const { store, session, manager } = await fixture(context, "tail");
  await store.updateTranscript(session.id, { earliestOffset: 100 });
  const stale = await manager.readOutput(session.id, 40, 100);
  assert.equal(stale.gap.reason, "retention");
  assert.match(stale.earliestCursor, /:100$/);
  assert.equal(stale.output, "tail");
  const ahead = await manager.readOutput(session.id, 999, 100);
  assert.equal(ahead.gap.reason, "cursor_ahead");
  assert.equal(ahead.output, "");
  assert.match(ahead.cursor, /:104$/);
  const otherStream = await manager.readOutput(session.id, "v1:other-stream:1:0", 100);
  assert.equal(otherStream.gap.reason, "stream_changed");
  assert.equal(otherStream.output, "tail");
});

test("CUR-06: storage reserve stops capture but leaves the terminal controlled", async (context) => {
  const { store, session, manager } = await fixture(context, "captured");
  manager.config.storageMinFreeBytes = 1024;
  manager.availableStorageBytes = async () => 0;
  manager.isAlive = async () => true;
  const tmuxCalls = [];
  manager.tmux = async (args) => tmuxCalls.push(args);
  const result = await manager.readOutput(session.id);
  assert.equal(result.alive, true);
  assert.equal(result.capture.state, "DEGRADED");
  assert.equal(result.capture.reason, "storage_reserve");
  assert.deepEqual(tmuxCalls, [["pipe-pane", "-t", `dpb_${session.id}`]]);
  assert.equal((await store.get(session.id)).transcriptCaptureState, "DEGRADED");
});

test("CUR-06: a capture stop while no client reads is visible after restart", async context => {
  const { dataDir, store, session, manager } = await fixture(context, "retained");
  await fs.writeFile(`${store.outputPath(session.id)}${CAPTURE_STOP_SUFFIX}`,
    "storage_reserve\n", { mode: 0o600 });
  const read = await manager.readOutput(session.id);
  assert.equal(read.output, "retained");
  assert.equal(read.capture.state, "DEGRADED");
  assert.equal(read.capture.reason, "storage_reserve");
  store.close();
  const resumed = new StateStore(dataDir);
  await resumed.init();
  context.after(() => resumed.close());
  assert.equal((await resumed.get(session.id)).transcriptGapReason, "storage_reserve");
});

test("CUR-06: an untrusted capture stop marker cannot be treated as healthy", async context => {
  const { store, session, manager } = await fixture(context, "retained");
  await fs.symlink(store.outputPath(session.id),
    `${store.outputPath(session.id)}${CAPTURE_STOP_SUFFIX}`);
  await assert.rejects(manager.readOutput(session.id), error =>
    error?.code === "transcript_capture_invalid" && error?.status === 503);
});

test("STR-03: transcript ceiling stops capture but leaves the terminal controlled", async (context) => {
  const { store, session, manager } = await fixture(context, "12345");
  manager.config.sessionOutputMaxBytes = 5;
  manager.isAlive = async () => true;
  const tmuxCalls = [];
  manager.tmux = async (args) => tmuxCalls.push(args);
  const result = await manager.readOutput(session.id);
  assert.equal(result.alive, true);
  assert.equal(result.output, "12345");
  assert.equal(result.capture.state, "DEGRADED");
  assert.equal(result.capture.reason, "transcript_limit");
  assert.deepEqual(tmuxCalls, [["pipe-pane", "-t", `dpb_${session.id}`]]);
  assert.equal((await store.get(session.id)).transcriptCaptureState, "DEGRADED");
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TmuxSessionManager } from "../apps/agent/src/tmux.js";

test("STR-03: new terminal capture pipe has a hard byte ceiling", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-tmux-limit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const manager = new TmuxSessionManager({
    config: { historyLines: 1000, sessionOutputMaxBytes: 12345, storageMinFreeBytes: 4096 },
    store: {
      async list() { return []; },
      sessionDir(id) { return path.join(root, id); },
      outputPath(id) { return path.join(root, id, "terminal.log"); },
      async save(session) { return session; },
    },
    pathPolicy: { resolve() { return root; } },
    logger: { info() {} },
  });
  manager.tmux = async (args) => calls.push(args);

  const opened = await manager.open({ cwd: ".", label: "bounded" });
  const pipe = calls.find((args) => args[0] === "pipe-pane");
  assert.match(
    pipe.at(-1),
    new RegExp(`^/usr/bin/env node '.*scripts/transcript-capture\\.mjs' '.*${opened.id}/terminal\\.log' 12345 4096$`),
  );
});

test("STR-05: active-session admission serializes concurrent opens at the hard limit", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-session-limit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let startFirst;
  let releaseFirst;
  const firstStarted = new Promise((resolve) => { startFirst = resolve; });
  const firstMayContinue = new Promise((resolve) => { releaseFirst = resolve; });
  const saved = [];
  const manager = new TmuxSessionManager({
    config: { historyLines: 1000, sessionOutputMaxBytes: 1024, terminalMaxActive: 1 },
    store: {
      async list() { return saved; },
      sessionDir(id) { return path.join(root, id); },
      outputPath(id) { return path.join(root, id, "terminal.log"); },
      async save(session) { saved.push(session); return session; },
    },
    pathPolicy: { resolve() { return root; } },
    logger: { info() {} },
  });
  manager.tmux = async (args) => {
    if (args[0] === "new-session" && saved.length === 0) {
      startFirst();
      await firstMayContinue;
    }
  };

  const first = manager.open({ cwd: ".", label: "first" });
  await firstStarted;
  await assert.rejects(
    manager.open({ cwd: ".", label: "second" }),
    (error) => error?.code === "session_limit" && error?.status === 429,
  );
  releaseFirst();
  const opened = await first;
  assert.equal(opened.alive, true);
  assert.equal(saved.length, 1);
  assert.equal(manager.pendingOpens, 0);
});

test("R0004: retained output and live reservations share one transcript quota", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-transcript-quota-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const records = [{ id: "live", closedAt: null }, { id: "retained", closedAt: "2026-09-26" }];
  const alive = new Set(["live"]);
  await fs.mkdir(path.join(root, "retained"));
  await fs.writeFile(path.join(root, "retained", "terminal.log"), "0123456789");
  const manager = new TmuxSessionManager({
    config: { terminalMaxActive: 8, sessionOutputMaxBytes: 10,
      transcriptTotalMaxBytes: 30, historyLines: 1000 },
    store: {
      async list() { return records; },
      sessionDir: id => path.join(root, id),
      outputPath: id => path.join(root, id, "terminal.log"),
      async save(session) { records.push(session); alive.add(session.id); return session; },
    },
    pathPolicy: { resolve() { return root; } },
    logger: { info() {} },
  });
  manager.isAlive = async id => alive.has(id);
  manager.tmux = async () => {};
  await manager.open({});
  await assert.rejects(manager.open({}), error =>
    error?.code === "transcript_quota" && error?.status === 507);
  records.splice(records.findIndex(record => record.id === "retained"), 1);
  await fs.rm(path.join(root, "retained"), { recursive: true });
  await manager.open({});
});

test("R0004: concurrent session opens reserve quota before starting tmux", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-pending-quota-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let unblock;
  let entered;
  const waiting = new Promise(resolve => { unblock = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const manager = new TmuxSessionManager({
    config: { terminalMaxActive: 8, sessionOutputMaxBytes: 10,
      transcriptTotalMaxBytes: 10, historyLines: 1000 },
    store: {
      async list() { return []; },
      sessionDir: id => path.join(root, id),
      outputPath: id => path.join(root, id, "terminal.log"),
      async save(session) { return session; },
    },
    pathPolicy: { resolve() { return root; } },
    logger: { info() {} },
  });
  manager.tmux = async args => {
    if (args[0] === "new-session") { entered(); await waiting; }
  };
  const first = manager.open({});
  await started;
  await assert.rejects(manager.open({}), error =>
    error?.code === "transcript_quota" && error?.status === 507);
  unblock();
  await first;
  assert.equal(manager.pendingOpens, 0);
});

test("uses an explicit tmux socket and prepares its persistent directory", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-tmux-socket-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const socket = path.join(root, "tmux", "tmux.sock");
  const manager = new TmuxSessionManager({
    config: { tmuxSocket: socket },
    store: {},
    pathPolicy: {},
    logger: {},
  });

  assert.deepEqual(
    manager.tmuxArgs(["has-session", "-t", "dpb_test"]),
    ["-S", socket, "has-session", "-t", "dpb_test"],
  );
  await manager.ensureSocketDirectory();
  assert.equal((await fs.stat(path.dirname(socket))).isDirectory(), true);
});

test("submits text and Enter in one paste-buffer payload", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-tmux-paste-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new TmuxSessionManager({
    config: {},
    store: { sessionDir() { return root; } },
    pathPolicy: {},
    logger: {},
  });
  manager.requireSession = async () => ({ id: "session-1" });
  const calls = [];
  let payload;
  manager.tmux = async (args) => {
    calls.push(args);
    if (args[0] === "load-buffer") payload = await fs.readFile(args.at(-1), "utf8");
  };

  await manager.paste("session-1", "printf atomic", true);

  assert.equal(payload, "printf atomic\n");
  assert.deepEqual(calls.map((args) => args[0]), ["load-buffer", "paste-buffer"]);
  assert.equal(calls.some((args) => args[0] === "send-keys"), false);
});

test("does not add Enter when input submission disables it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-tmux-paste-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new TmuxSessionManager({
    config: {},
    store: { sessionDir() { return root; } },
    pathPolicy: {},
    logger: {},
  });
  manager.requireSession = async () => ({ id: "session-1" });
  let payload;
  manager.tmux = async (args) => {
    if (args[0] === "load-buffer") payload = await fs.readFile(args.at(-1), "utf8");
  };

  await manager.paste("session-1", "partial input", false);

  assert.equal(payload, "partial input");
});

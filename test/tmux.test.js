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
    config: { historyLines: 1000, sessionOutputMaxBytes: 12345 },
    store: {
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
    new RegExp(`^/usr/bin/env node '.*scripts/transcript-capture\\.mjs' '.*${opened.id}/terminal\\.log' 12345$`),
  );
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

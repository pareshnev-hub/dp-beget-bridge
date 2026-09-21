import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TmuxSessionManager } from "../apps/agent/src/tmux.js";

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

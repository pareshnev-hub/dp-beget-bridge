import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "../apps/agent/src/state-store.js";

test("persists and removes terminal session metadata", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-store-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new StateStore(dataDir);
  t.after(() => store.close());
  await store.init();
  const session = {
    id: "session-1",
    label: "Test terminal",
    cwd: "/workspace",
    createdAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
  };
  await store.save(session);
  assert.deepEqual(await store.get(session.id), session);
  assert.deepEqual(await store.list(), [session]);
  await store.remove(session.id);
  assert.equal(await store.get(session.id), null);
});

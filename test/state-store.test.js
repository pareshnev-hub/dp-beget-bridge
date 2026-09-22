import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { StateStore } from "../apps/agent/src/state-store.js";

test("persists, closes, and explicitly purges terminal session metadata", async (t) => {
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
  const saved = await store.save(session);
  assert.equal((await store.get(session.id)).transcriptStreamId, saved.transcriptStreamId);
  const closed = await store.closeSession(session.id);
  assert.equal(closed.state, "CLOSED");
  assert.equal((await store.list()).length, 1);
  await store.purge(session.id);
  assert.equal(await store.get(session.id), null);
});

test("schema v1 migrates to v2 without changing retained transcript bytes", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-store-v1-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const sessionDir = path.join(dataDir, "sessions", "legacy-session");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, "terminal.log"), "legacy transcript🙂");
  const database = new DatabaseSync(path.join(dataDir, "state.sqlite"));
  database.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, label TEXT NOT NULL, cwd TEXT NOT NULL,
      created_at TEXT NOT NULL, closed_at TEXT
    ) STRICT;
    CREATE TABLE operations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      exit_code INTEGER,
      outcome_reason TEXT,
      start_cursor INTEGER NOT NULL DEFAULT 0,
      UNIQUE(session_id, idempotency_key)
    ) STRICT;
    INSERT INTO sessions VALUES (
      'legacy-session', 'Legacy', '/workspace', '2026-09-21T00:00:00.000Z',
      '2026-09-21T01:00:00.000Z'
    );
    PRAGMA user_version = 1;
  `);
  database.close();

  const store = new StateStore(dataDir);
  await store.init();
  t.after(() => store.close());
  const migrated = await store.get("legacy-session");
  assert.equal(migrated.state, "CLOSED");
  assert.equal(migrated.transcriptCaptureState, "STOPPED");
  assert.match(migrated.transcriptStreamId, /^[a-f0-9]{32}$/);
  assert.equal(await fs.readFile(store.outputPath("legacy-session"), "utf8"), "legacy transcript🙂");
  const verification = new DatabaseSync(store.databasePath, { readOnly: true });
  assert.equal(verification.prepare("PRAGMA user_version").get().user_version, 2);
  verification.close();
  assert.equal(await fs.stat(path.join(dataDir, "state.sqlite.backup-v1")).then(() => true), true);
});

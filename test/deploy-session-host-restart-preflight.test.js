import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  assertSessionHostRestartSafe,
  inspectSessionHostRestart,
} from "../scripts/deploy/session-host-restart-preflight.mjs";

async function fixture() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "dpb-restart-preflight-"));
  return {
    directory,
    databasePath: path.join(directory, "state.sqlite"),
    cleanup: () => fsp.rm(directory, { recursive: true, force: true }),
  };
}

function createDatabase(databasePath, statuses = []) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE operations (status TEXT NOT NULL) STRICT;
    PRAGMA user_version = 1;
  `);
  const insert = database.prepare("INSERT INTO operations (status) VALUES (?)");
  for (const status of statuses) insert.run(status);
  database.close();
}

test("restart preflight fails closed when state cannot prove safety", async () => {
  const state = await fixture();
  try {
    assert.throws(() => inspectSessionHostRestart(state.databasePath), /state database is missing/);
    new DatabaseSync(state.databasePath).close();
    assert.throws(() => inspectSessionHostRestart(state.databasePath), /unsupported state schema 0/);
  } finally {
    await state.cleanup();
  }
});

test("restart preflight rejects accepted and running operations", async () => {
  for (const status of ["ACCEPTED", "RUNNING"]) {
    const state = await fixture();
    try {
      createDatabase(state.databasePath, [status]);
      assert.throws(
        () => assertSessionHostRestartSafe(state.databasePath),
        /1 accepted or running operation\(s\) remain/,
      );
    } finally {
      await state.cleanup();
    }
  }
});

test("restart preflight permits only terminal operation states", async () => {
  const state = await fixture();
  try {
    createDatabase(state.databasePath, ["SUCCEEDED", "FAILED", "INTERRUPTED", "UNKNOWN"]);
    assert.deepEqual(assertSessionHostRestartSafe(state.databasePath), {
      schemaVersion: 1,
      activeOperationCount: 0,
    });
  } finally {
    await state.cleanup();
  }
});

test("restart preflight rejects a missing operations table", async () => {
  const state = await fixture();
  try {
    const database = new DatabaseSync(state.databasePath);
    database.exec("PRAGMA user_version = 1;");
    database.close();
    assert.equal(fs.existsSync(state.databasePath), true);
    assert.throws(() => inspectSessionHostRestart(state.databasePath), /operations table is missing/);
  } finally {
    await state.cleanup();
  }
});

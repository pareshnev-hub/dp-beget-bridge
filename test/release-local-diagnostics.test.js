import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { inspectLocalDisk, inspectLocalRelease,
  inspectLocalState } from "../scripts/release/local-diagnostics.mjs";

test("R0004: doctor identifies the exact managed release and local schema read-only", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-diagnostics-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const commit = "a".repeat(40);
  const version = `0.1.0-${commit}`;
  const release = path.join(root, "releases", version);
  await fs.mkdir(release, { recursive: true });
  await fs.writeFile(path.join(release, "package.json"),
    JSON.stringify({ name: "dp-beget-bridge", version: "0.1.0" }));
  assert.deepEqual(await inspectLocalRelease(root), { mode: "legacy" });
  await fs.symlink(`releases/${version}`, path.join(root, "current"));
  assert.deepEqual(await inspectLocalRelease(root), { mode: "managed", version: "0.1.0", commit });
  const databasePath = path.join(root, "state.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA user_version = 2");
  db.close();
  assert.deepEqual(await inspectLocalState(databasePath), { schema: 2 });
  assert.deepEqual(await inspectLocalDisk(root, 1), { reserve: "ok" });
  await assert.rejects(inspectLocalDisk(root, Number.MAX_SAFE_INTEGER),
    error => error.code === "LOW_DISK");
  await fs.writeFile(path.join(release, "package.json"),
    JSON.stringify({ name: "dp-beget-bridge", version: "1.0.0" }));
  await assert.rejects(inspectLocalRelease(root), /does not match/);
});

test("R0004: doctor refuses a release pointer or state symlink outside its root", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-diagnostics-links-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.symlink("../outside", path.join(root, "current"));
  await assert.rejects(inspectLocalRelease(root), /Invalid managed release pointer/);
  const database = path.join(root, "real.sqlite");
  const db = new DatabaseSync(database);
  db.exec("PRAGMA user_version = 2");
  db.close();
  await fs.symlink(database, path.join(root, "state.sqlite"));
  await assert.rejects(inspectLocalState(path.join(root, "state.sqlite")));
});

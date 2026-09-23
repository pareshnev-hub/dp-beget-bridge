import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { backupSqliteSet } from "../scripts/release/backup-sqlite.mjs";

test("OPS-06: SQLite backup captures committed WAL rows and retains the old snapshot", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.sqlite");
  const live = new DatabaseSync(source);
  try {
    live.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=2; CREATE TABLE items (value TEXT);");
    live.prepare("INSERT INTO items VALUES (?)").run("before");
    const outputDir = path.join(root, "backup");
    const manifest = await backupSqliteSet({ databases: [{ name: "session", source }], outputDir, minFreeBytes: 0 });
    assert.equal(manifest.databases[0].schemaVersion, 2);
    assert.match(manifest.databases[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal((await stat(outputDir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(outputDir, "session.sqlite"))).mode & 0o777, 0o600);
    live.prepare("INSERT INTO items VALUES (?)").run("after");
    const backup = new DatabaseSync(path.join(outputDir, "session.sqlite"), { readOnly: true });
    try { assert.deepEqual(backup.prepare("SELECT value FROM items").all().map(row => row.value), ["before"]); }
    finally { backup.close(); }
    assert.equal(JSON.parse(await readFile(path.join(outputDir, "backup-manifest.json"), "utf8")).databases[0].name, "session");
    await assert.rejects(backupSqliteSet({ databases: [{ name: "session", source }], outputDir, minFreeBytes: 0 }), /EEXIST/);
  } finally { live.close(); }
});

test("OPS-06: insufficient free-space policy fails before creating a backup directory", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-backup-no-space-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.sqlite");
  const db = new DatabaseSync(source);
  db.exec("CREATE TABLE data (value TEXT)");
  db.close();
  const outputDir = path.join(root, "backup");
  await assert.rejects(backupSqliteSet({ databases: [{ name: "state", source }], outputDir,
    minFreeBytes: Number.MAX_SAFE_INTEGER }), /Insufficient free space/);
  await assert.rejects(stat(outputDir), /ENOENT/);
});

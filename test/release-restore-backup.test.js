import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { backupConfig } from "../scripts/release/backup-config.mjs";
import { backupSqliteSet } from "../scripts/release/backup-sqlite.mjs";
import { restoreConfig, restoreSqliteSet } from "../scripts/release/restore-backup.mjs";

test("OPS-06: configuration round trip preserves private content, modes and nested directories", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-restore-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = path.join(root, "original");
  const backup = path.join(root, "backup");
  const restored = path.join(root, "restored");
  await mkdir(path.join(original, "nested"), { recursive: true, mode: 0o700 });
  await writeFile(path.join(original, "nested", "secret.env"), "ACCESS_TOKEN=canary\n", { mode: 0o600 });
  await backupConfig({ configRoot: original, outputDir: backup });
  const result = await restoreConfig({ backupDir: backup, outputDir: restored });
  assert.equal(result.entries, 2);
  assert.equal(await readFile(path.join(restored, "nested", "secret.env"), "utf8"), "ACCESS_TOKEN=canary\n");
  assert.equal((await stat(path.join(restored, "nested", "secret.env"))).mode & 0o777, 0o600);
  await assert.rejects(restoreConfig({ backupDir: backup, outputDir: restored }), /EEXIST/);
});

test("OPS-06: tampered or linked configuration backup fails before restore directory exists", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-restore-tamper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = path.join(root, "original");
  const backup = path.join(root, "backup");
  await mkdir(original);
  await writeFile(path.join(original, "agent.env"), "private\n");
  await backupConfig({ configRoot: original, outputDir: backup });
  await writeFile(path.join(backup, "agent.env"), "changed\n");
  await assert.rejects(restoreConfig({ backupDir: backup, outputDir: path.join(root, "restored") }), /checksum mismatch/);
  await assert.rejects(stat(path.join(root, "restored")), /ENOENT/);
  await rm(path.join(backup, "agent.env"));
  await symlink("/etc/passwd", path.join(backup, "agent.env"));
  await assert.rejects(restoreConfig({ backupDir: backup, outputDir: path.join(root, "restored") }));
  await assert.rejects(stat(path.join(root, "restored")), /ENOENT/);
});

test("OPS-06: committed WAL rows restore as a standalone, checked SQLite database", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-restore-sqlite-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.sqlite");
  const live = new DatabaseSync(source);
  try {
    live.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=4; CREATE TABLE data (value TEXT)");
    live.prepare("INSERT INTO data VALUES (?)").run("before");
    const backup = path.join(root, "backup");
    await backupSqliteSet({ databases: [{ name: "agent", source }], outputDir: backup, minFreeBytes: 0 });
    await assert.rejects(stat(path.join(backup, "agent.sqlite-wal")), /ENOENT/);
    await assert.rejects(stat(path.join(backup, "agent.sqlite-shm")), /ENOENT/);
    live.prepare("INSERT INTO data VALUES (?)").run("after");
    const restored = path.join(root, "restored");
    assert.deepEqual(await restoreSqliteSet({ backupDir: backup, outputDir: restored }), { databases: ["agent"] });
    const db = new DatabaseSync(path.join(restored, "agent.sqlite"), { readOnly: true });
    try { assert.deepEqual(db.prepare("SELECT value FROM data").all().map(row => row.value), ["before"]); }
    finally { db.close(); }
    assert.equal((await stat(path.join(restored, "agent.sqlite"))).mode & 0o777, 0o600);
    await writeFile(path.join(backup, "agent.sqlite"), "broken");
    await assert.rejects(restoreSqliteSet({ backupDir: backup, outputDir: path.join(root, "bad") }));
    await assert.rejects(stat(path.join(root, "bad")), /ENOENT/);
  } finally { live.close(); }
});

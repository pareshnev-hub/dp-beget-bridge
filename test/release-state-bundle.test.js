import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { backupStateBundle } from "../scripts/release/backup-state-bundle.mjs";
import { inspectStateBundleSpace } from "../scripts/release/inspect-state-bundle-space.mjs";
import { restoreStateBundle } from "../scripts/release/restore-state-bundle.mjs";

test("OPS-06: stopped writers produce one private, restorable config and multi-DB snapshot", {
  skip: process.getuid?.() !== 0
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-state-bundle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configRoot = path.join(root, "config");
  await mkdir(configRoot, { mode: 0o700 });
  await writeFile(path.join(configRoot, "oauth.env"), "PRIVATE_TOKEN=canary\n", { mode: 0o600 });
  const databases = [];
  for (const name of ["agent", "oauth", "session"]) {
    const source = path.join(root, `${name}.sqlite`);
    const db = new DatabaseSync(source);
    db.exec("CREATE TABLE data (value TEXT)");
    db.prepare("INSERT INTO data VALUES (?)").run(name);
    db.close();
    if (name === "agent") await chmod(source, 0o640);
    databases.push({ name, source });
  }
  let checks = 0;
  const outputDir = path.join(root, "snapshot");
  const manifest = await backupStateBundle({ configRoot, databases, outputDir,
    assertQuiesced: async () => { checks++; } });
  assert.equal(checks, 2);
  assert.deepEqual(manifest.databases, ["agent", "oauth", "session"]);
  assert.equal(manifest.format, "dp-beget-bridge-state-bundle-v2");
  assert.deepEqual(manifest.sources, { configRoot,
    databases: databases.map(item => ({ name: item.name, path: item.source })) });
  assert.doesNotMatch(JSON.stringify(manifest), /PRIVATE_TOKEN/);
  assert.equal((await stat(outputDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(outputDir, "bundle-manifest.json"))).mode & 0o777, 0o600);
  const restoreDir = path.join(root, "restored");
  const recovered = await restoreStateBundle({ backupDir: outputDir, outputDir: restoreDir });
  assert.deepEqual(recovered.databases, manifest.databases);
  assert.deepEqual(recovered.sources, manifest.sources);
  const restoredAgent = await stat(path.join(restoreDir, "sqlite", "agent.sqlite"));
  assert.equal(restoredAgent.uid, (await stat(databases[0].source)).uid);
  assert.equal(restoredAgent.gid, (await stat(databases[0].source)).gid);
  assert.equal(restoredAgent.mode & 0o777, 0o640);
  const snapshotAgent = await stat(path.join(outputDir, "sqlite", "agent.sqlite"));
  assert.equal(snapshotAgent.uid, process.getuid());
  assert.equal(snapshotAgent.mode & 0o777, 0o600);
  const configOutput = path.join(restoreDir, "config");
  const sqliteOutput = path.join(restoreDir, "sqlite");
  assert.equal(await readFile(path.join(configOutput, "oauth.env"), "utf8"), "PRIVATE_TOKEN=canary\n");
  for (const name of manifest.databases) {
    const db = new DatabaseSync(path.join(sqliteOutput, `${name}.sqlite`), { readOnly: true });
    try { assert.equal(db.prepare("SELECT value FROM data").get().value, name); }
    finally { db.close(); }
  }
  const manifestPath = path.join(outputDir, "bundle-manifest.json");
  const altered = { ...manifest, sources: { ...manifest.sources,
    databases: manifest.sources.databases.map((item, index) => index === 0
      ? { ...item, path: "/tmp/../wrong.sqlite" } : item) } };
  await writeFile(manifestPath, JSON.stringify(altered));
  await assert.rejects(restoreStateBundle({ backupDir: outputDir,
    outputDir: path.join(root, "unsafe-targets") }), /Invalid state bundle manifest/);
  await assert.rejects(stat(path.join(root, "unsafe-targets")), /ENOENT/);
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(path.join(outputDir, "config", "backup-manifest.json"), "tampered");
  await assert.rejects(restoreStateBundle({ backupDir: outputDir, outputDir: path.join(root, "rejected") }),
    /manifest checksum mismatch/);
  await assert.rejects(stat(path.join(root, "rejected")), /ENOENT/);
});

test("OPS-06: a restarted writer or missing DB removes the incomplete bundle", {
  skip: process.getuid?.() !== 0
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-state-incomplete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configRoot = path.join(root, "config");
  await mkdir(configRoot);
  await writeFile(path.join(configRoot, "agent.env"), "private");
  const source = path.join(root, "agent.sqlite");
  const db = new DatabaseSync(source);
  db.exec("CREATE TABLE t (value TEXT)");
  db.close();
  const databases = [{ name: "agent", source }];
  const outputDir = path.join(root, "snapshot");
  let checks = 0;
  await assert.rejects(backupStateBundle({ configRoot, databases, outputDir,
    assertQuiesced: async () => { if (++checks === 2) throw new Error("Writer restarted"); } }), /Writer restarted/);
  await assert.rejects(stat(outputDir), /ENOENT/);
  await assert.rejects(backupStateBundle({ configRoot, databases: [{ name: "missing", source: path.join(root, "missing.sqlite") }],
    outputDir, assertQuiesced: async () => {} }), /ENOENT/);
  await assert.rejects(stat(outputDir), /ENOENT/);
});

test("OPS-06: insufficient rollback headroom refuses a grouped snapshot before any write", {
  skip: process.getuid?.() !== 0
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-state-capacity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configRoot = path.join(root, "config");
  await mkdir(configRoot);
  const source = path.join(root, "agent.sqlite");
  const db = new DatabaseSync(source);
  db.exec("CREATE TABLE t (value TEXT)");
  db.close();
  const databases = [{ name: "agent", source }];
  const result = await inspectStateBundleSpace({ databases, parent: root,
    inspectFilesystem: async () => ({ bavail: 1024n * 1024n * 1024n, bsize: 1n }) });
  assert.ok(result.requiredBytes > 512n * 1024n * 1024n);
  assert.match(result.scope, /artifact excluded/);
  let quiesceChecks = 0;
  const outputDir = path.join(root, "snapshot");
  await assert.rejects(backupStateBundle({ configRoot, databases, outputDir,
    inspectSpace: args => inspectStateBundleSpace({ ...args,
      inspectFilesystem: async () => ({ bavail: result.requiredBytes - 1n, bsize: 1n }) }),
    assertQuiesced: async () => { quiesceChecks++; } }), /Insufficient free space/);
  assert.equal(quiesceChecks, 0);
  await assert.rejects(stat(outputDir), /ENOENT/);
});

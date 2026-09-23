import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, symlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backupConfig } from "../scripts/release/backup-config.mjs";

test("R0004 configuration backup keeps credentials private and records ownership/mode without printing values", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configRoot = path.join(root, "config");
  const outputDir = path.join(root, "backup");
  await mkdir(configRoot, { mode: 0o750 });
  const secret = "DP_AGENT_TOKEN=purpose-built-secret\n";
  await writeFile(path.join(configRoot, "agent.env"), secret, { mode: 0o640 });
  const manifest = await backupConfig({ configRoot, outputDir });
  assert.equal((await stat(outputDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(outputDir, "agent.env"))).mode & 0o777, 0o600);
  assert.equal(await readFile(path.join(outputDir, "agent.env"), "utf8"), secret);
  assert.equal(manifest.entries[0].mode, 0o640);
  assert.doesNotMatch(JSON.stringify(manifest), /purpose-built-secret/);
  await assert.rejects(backupConfig({ configRoot, outputDir }), /EEXIST/);
});

test("R0004 configuration backup rejects a symlink before creating any backup", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-config-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configRoot = path.join(root, "config");
  const outputDir = path.join(root, "backup");
  await mkdir(configRoot);
  await symlink("/etc/passwd", path.join(configRoot, "external.env"));
  await assert.rejects(backupConfig({ configRoot, outputDir }), /links and special files/);
  await assert.rejects(stat(outputDir), /ENOENT/);
});

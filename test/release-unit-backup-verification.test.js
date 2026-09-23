import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifySystemdUnitBackup } from "../scripts/release/verify-systemd-unit-backup.mjs";

const UNITS = ["dp-beget-session-host.service", "dp-beget-agent.service",
  "dp-beget-mcp.service", "dp-beget-mcp-oauth-spike.service",
  "dp-beget-oauth-proxy.socket", "dp-beget-oauth-proxy.service", "dp-beget-tunnel.service"];

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-unit-verify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backupDir = path.join(root, "backup");
  await mkdir(path.join(backupDir, "files"), { recursive: true, mode: 0o700 });
  const files = [];
  for (const unit of UNITS) {
    const bytes = Buffer.from(`[Unit]\nDescription=${unit}\n`);
    await writeFile(path.join(backupDir, "files", unit), bytes, { mode: 0o600 });
    files.push({ unit, path: unit, uid: 0, gid: 0, mode: 0o644, size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const manifest = { format: "dp-beget-bridge-unit-backup-v1", createdAt: new Date().toISOString(), files };
  await writeFile(path.join(backupDir, "backup-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  return { backupDir, manifest };
}

test("OPS-07: verify complete root-owned systemd unit snapshot and digest", { skip: process.getuid?.() !== 0 }, async t => {
  const { backupDir } = await fixture(t);
  const result = await verifySystemdUnitBackup({ backupDir });
  assert.equal(result.files, 7);
  assert.match(result.manifestSha256, /^[0-9a-f]{64}$/);
});

test("OPS-07: modified bytes, missing unit and extra file cannot pass backup verification", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { backupDir, manifest } = await fixture(t);
  await writeFile(path.join(backupDir, "files", UNITS[0]), "altered\n");
  await assert.rejects(verifySystemdUnitBackup({ backupDir }));
  await writeFile(path.join(backupDir, "files", UNITS[0]), `[Unit]\nDescription=${UNITS[0]}\n`);
  manifest.files.pop();
  await writeFile(path.join(backupDir, "backup-manifest.json"), JSON.stringify(manifest));
  await assert.rejects(verifySystemdUnitBackup({ backupDir }), /Invalid unit backup manifest/);
  manifest.files.push({ unit: UNITS[6], path: UNITS[6], uid: 0, gid: 0, mode: 0o644,
    size: Buffer.byteLength(`[Unit]\nDescription=${UNITS[6]}\n`),
    sha256: createHash("sha256").update(`[Unit]\nDescription=${UNITS[6]}\n`).digest("hex") });
  await writeFile(path.join(backupDir, "backup-manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(backupDir, "files", "extra.conf"), "extra\n", { mode: 0o600 });
  await assert.rejects(verifySystemdUnitBackup({ backupDir }), /Unexpected unit backup file inventory/);
});

import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const UNITS = ["dp-beget-session-host.service", "dp-beget-agent.service",
  "dp-beget-mcp.service", "dp-beget-mcp-oauth-spike.service",
  "dp-beget-oauth-proxy.socket", "dp-beget-oauth-proxy.service", "dp-beget-tunnel.service"];

export async function unitBackupFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-journal-units-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const backupDir = path.join(root, "units");
  await mkdir(path.join(backupDir, "files"), { recursive: true, mode: 0o700 });
  const files = [];
  for (const unit of UNITS) {
    const bytes = Buffer.from(`[Unit]\nDescription=${unit}\n`);
    await writeFile(path.join(backupDir, "files", unit), bytes, { mode: 0o600 });
    files.push({ unit, path: unit, uid: 0, gid: 0, mode: 0o644, size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await writeFile(path.join(backupDir, "backup-manifest.json"), JSON.stringify({
    format: "dp-beget-bridge-unit-backup-v1", createdAt: new Date().toISOString(), files
  }), { mode: 0o600 });
  return { root, backupDir };
}

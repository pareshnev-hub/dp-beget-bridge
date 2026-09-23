import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectMigrationRecovery } from "../scripts/release/inspect-migration-recovery.mjs";
import { advanceMigrationJournal, startMigrationJournal } from "../scripts/release/migration-journal.mjs";
import { unitBackupFixture } from "./fixtures/unit-backup.js";

test("recovery inspection fails closed on interrupted and missing-marker phases", { skip: process.getuid?.() !== 0 }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "dp-recovery-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const journalPath = path.join(base, "journal.json");
  const marker = path.join(base, "marker");
  const { backupDir } = await unitBackupFixture(t);
  assert.deepEqual(await inspectMigrationRecovery({ journalPath, marker }),
    { state: "no-transaction", ingressMayOpen: false });
  await startMigrationJournal(journalPath, { oldCommit: "a".repeat(40), newCommit: "b".repeat(40),
    artifactSha256: "c".repeat(64), unitBackupDir: backupDir });
  await advanceMigrationJournal(journalPath, "prepared", "guarded");
  await advanceMigrationJournal(journalPath, "guarded", "ingress-closed");
  assert.equal((await inspectMigrationRecovery({ journalPath, marker })).state, "missing-guard-marker");
  await writeFile(marker, "incomplete\n", { mode: 0o600 });
  assert.equal((await inspectMigrationRecovery({ journalPath, marker })).state, "incomplete-transaction");
  await writeFile(`${journalPath}.lock`, "interrupted\n", { mode: 0o600 });
  assert.deepEqual(await inspectMigrationRecovery({ journalPath, marker }),
    { state: "interrupted-transition", phase: "ingress-closed", ingressMayOpen: false });
  await writeFile(path.join(backupDir, "files", "dp-beget-agent.service"), "tampered\n");
  await assert.rejects(inspectMigrationRecovery({ journalPath, marker }), /backup file|digest mismatch/);
  await writeFile(path.join(backupDir, "files", "dp-beget-agent.service"),
    "[Unit]\nDescription=dp-beget-agent.service\n");
  const manifestPath = path.join(backupDir, "backup-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.createdAt = "2026-09-24T00:00:00.000Z";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(inspectMigrationRecovery({ journalPath, marker }), /no longer matches/);
});

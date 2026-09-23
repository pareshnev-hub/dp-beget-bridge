import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectMigrationRecovery } from "../scripts/release/inspect-migration-recovery.mjs";
import { advanceMigrationJournal, startMigrationJournal } from "../scripts/release/migration-journal.mjs";

test("recovery inspection fails closed on interrupted and missing-marker phases", { skip: process.getuid?.() !== 0 }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "dp-recovery-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const journalPath = path.join(base, "journal.json");
  const marker = path.join(base, "marker");
  assert.deepEqual(await inspectMigrationRecovery({ journalPath, marker }),
    { state: "no-transaction", ingressMayOpen: false });
  await startMigrationJournal(journalPath, { oldCommit: "a".repeat(40), newCommit: "b".repeat(40),
    artifactSha256: "c".repeat(64) });
  await advanceMigrationJournal(journalPath, "prepared", "guarded");
  await advanceMigrationJournal(journalPath, "guarded", "ingress-closed");
  assert.equal((await inspectMigrationRecovery({ journalPath, marker })).state, "missing-guard-marker");
  await writeFile(marker, "incomplete\n", { mode: 0o600 });
  assert.equal((await inspectMigrationRecovery({ journalPath, marker })).state, "incomplete-transaction");
  await writeFile(`${journalPath}.lock`, "interrupted\n", { mode: 0o600 });
  assert.deepEqual(await inspectMigrationRecovery({ journalPath, marker }),
    { state: "interrupted-transition", phase: "ingress-closed", ingressMayOpen: false });
});

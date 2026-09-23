import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { advanceMigrationJournal, readMigrationJournal, startMigrationJournal } from "../scripts/release/migration-journal.mjs";

const oldCommit = "a".repeat(40);
const newCommit = "b".repeat(40);
const artifactSha256 = "c".repeat(64);

test("journal is durable, private, ordered and leaves no success phase on rejected transitions", {
  skip: process.getuid?.() !== 0
}, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "dp-migration-journal-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const journal = path.join(base, "journal.json");
  const initial = await startMigrationJournal(journal, { oldCommit, newCommit, artifactSha256 });
  assert.equal(initial.phase, "prepared");
  await assert.rejects(startMigrationJournal(journal, { oldCommit, newCommit, artifactSha256 }), /EEXIST/);
  await assert.rejects(advanceMigrationJournal(journal, "prepared", "snapshotted"), /rejected/);
  assert.equal((await readMigrationJournal(journal)).phase, "prepared");
  await advanceMigrationJournal(journal, "prepared", "guarded");
  await assert.rejects(advanceMigrationJournal(journal, "prepared", "ingress-closed"), /rejected/);
  await advanceMigrationJournal(journal, "guarded", "ingress-closed");
  await advanceMigrationJournal(journal, "ingress-closed", "quiesced");
  await assert.rejects(advanceMigrationJournal(journal, "quiesced", "snapshotted"), /Snapshot path required/);
  assert.equal((await readMigrationJournal(journal)).phase, "quiesced");
  const next = await advanceMigrationJournal(journal, "quiesced", "snapshotted",
    { snapshotPath: path.join(base, "snapshot") });
  assert.equal(next.transactionId, initial.transactionId);
  assert.equal(next.snapshotPath, path.join(base, "snapshot"));
  assert.equal((await readFile(journal, "utf8")).includes("snapshotPath"), true);
  await writeFile(`${journal}.lock`, "interrupted transition\n", { flag: "wx", mode: 0o600 });
  await assert.rejects(advanceMigrationJournal(journal, "snapshotted", "switched"), /EEXIST/);
  assert.equal((await readMigrationJournal(journal)).phase, "snapshotted");
});

test("journal rejects malformed previous state before any transition", { skip: process.getuid?.() !== 0 }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "dp-migration-journal-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const journal = path.join(base, "journal.json");
  await writeFile(journal, '{"phase":"completed"}\n', { mode: 0o600 });
  await assert.rejects(advanceMigrationJournal(journal, "completed", "prepared"), /Invalid migration journal/);
});

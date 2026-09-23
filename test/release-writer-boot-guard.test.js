import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MANAGED_APP_UNITS } from "../scripts/release/stage-managed-unit-overrides.mjs";
import { stageWriterBootGuard, WRITER_GUARD_DROP_IN, writerGuardContent } from
  "../scripts/release/writer-boot-guard.mjs";

const run = promisify(execFile);

test("writer boot guard permits normal boot and short-lived explicit migration starts", async t => {
  if (process.getuid?.() !== 0 || process.platform !== "linux") { t.skip("systemd root test"); return; }
  const root = await mkdtemp("/var/lib/dp-writer-guard-test-");
  const runRoot = await mkdtemp("/run/dp-writer-guard-test-");
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(runRoot, { recursive: true, force: true }));
  const marker = path.join(root, "migration-incomplete");
  const permit = path.join(runRoot, "writer-start-allowed");
  const outputDir = path.join(root, "guards");
  const report = await stageWriterBootGuard({ outputDir, marker, permit });
  assert.deepEqual(report.units, MANAGED_APP_UNITS);
  const expected = writerGuardContent(marker, permit);
  for (const unit of MANAGED_APP_UNITS) {
    assert.equal(await readFile(path.join(outputDir, `${unit}.d`, WRITER_GUARD_DROP_IN), "utf8"), expected);
  }
  const conditions = expected.trim().split("\n").slice(1);
  assert.match((await run("systemd-analyze", ["condition", ...conditions])).stderr, /Conditions succeeded/);
  await writeFile(marker, "incomplete\n");
  await assert.rejects(run("systemd-analyze", ["condition", ...conditions]));
  await writeFile(permit, "temporary\n");
  assert.match((await run("systemd-analyze", ["condition", ...conditions])).stderr, /Conditions succeeded/);
  await rm(permit);
  await assert.rejects(run("systemd-analyze", ["condition", ...conditions]));
});

test("writer start permit must live under ephemeral /run", () => {
  assert.throws(() => writerGuardContent(undefined, "/var/lib/persistent-permit"), /ephemeral/);
  assert.throws(() => writerGuardContent(undefined, "/run/../var/lib/permit"), /ephemeral/);
});

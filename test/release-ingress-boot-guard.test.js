import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertIngressBootGuard, guardContent, INGRESS_UNITS,
  PERSISTENT_MARKER, stageIngressBootGuard } from "../scripts/release/ingress-boot-guard.mjs";

test("migration ingress guard persists across reboot and scopes only dedicated ingress", { skip: process.getuid?.() !== 0 }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "dp-ingress-guard-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const outputDir = path.join(base, "guard");
  const result = await stageIngressBootGuard({ outputDir });
  assert.deepEqual(result.units, INGRESS_UNITS);
  assert.equal(result.marker, PERSISTENT_MARKER);
  assert.equal(await assertIngressBootGuard({ unitDirectory: outputDir }), true);
  assert.equal(await readFile(path.join(outputDir, `${INGRESS_UNITS[0]}.d`, result.dropIn), "utf8"),
    `[Unit]\nConditionPathExists=!${PERSISTENT_MARKER}\n`);
  assert.equal(INGRESS_UNITS.some(unit => unit.includes("traefik")), false);
  await assert.rejects(stageIngressBootGuard({ outputDir }), /EEXIST/);
  await unlink(path.join(outputDir, `${INGRESS_UNITS[1]}.d`, result.dropIn));
  await assert.rejects(assertIngressBootGuard({ unitDirectory: outputDir }), /ENOENT/);
});

test("migration guard rejects volatile and injected marker paths", () => {
  for (const marker of ["/run/dp/marker", "/tmp/marker", "/proc/marker", "relative", "/var/lib/x\n[Service]", "/var/lib/%n", "/var/lib/../x"]) {
    assert.throws(() => guardContent(marker));
  }
});

test("migration guard detects altered drop-in", { skip: process.getuid?.() !== 0 }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "dp-ingress-guard-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const outputDir = path.join(base, "guard");
  const result = await stageIngressBootGuard({ outputDir });
  await writeFile(path.join(outputDir, `${INGRESS_UNITS[2]}.d`, result.dropIn), "[Unit]\nConditionPathExists=/tmp/other\n");
  await assert.rejects(assertIngressBootGuard({ unitDirectory: outputDir }), /Unexpected guard/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MANAGED_APP_UNITS, managedUnitContent, stageManagedUnitOverrides } from
  "../scripts/release/stage-managed-unit-overrides.mjs";

test("OPS-07: four service overrides bind to one managed version link without changing original fragments", {
  skip: process.getuid?.() !== 0
}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-managed-units-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseRoot = path.join(root, "release-root");
  await mkdir(releaseRoot, { mode: 0o755 });
  const outputDir = path.join(root, "staged");
  const result = await stageManagedUnitOverrides({ outputDir, releaseRoot });
  assert.deepEqual(result.units, MANAGED_APP_UNITS);
  assert.equal(result.workingDirectory, path.join(releaseRoot, "current"));
  for (const unit of MANAGED_APP_UNITS) {
    const filename = path.join(outputDir, `${unit}.d`, result.dropIn);
    assert.equal(await readFile(filename, "utf8"), `[Service]\nWorkingDirectory=${releaseRoot}/current\n`);
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
  }
  await assert.rejects(stageManagedUnitOverrides({ outputDir, releaseRoot }), /EEXIST/);
});

test("OPS-07: release path cannot inject extra systemd directives", () => {
  for (const value of ["relative", "/opt/release\nExecStart=/bin/sh", "/opt/%n", "/opt/a b", "/opt/../release"]) {
    assert.throws(() => managedUnitContent(value));
  }
});

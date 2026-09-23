import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertWriterPermitAbsent, withWriterStartPermit } from
  "../scripts/release/writer-start-permit.mjs";

async function fixture(t) {
  const markerRoot = await mkdtemp("/var/lib/dp-writer-permit-test-");
  const permitRoot = await mkdtemp("/run/dp-writer-permit-test-");
  t.after(() => rm(markerRoot, { recursive: true, force: true }));
  t.after(() => rm(permitRoot, { recursive: true, force: true }));
  const marker = path.join(markerRoot, "migration-incomplete");
  const permit = path.join(permitRoot, "writer-start-allowed");
  await writeFile(marker, "dp-beget-bridge-migration-incomplete-v1\n", { mode: 0o600 });
  return { marker, permit };
}

test("OPS-07: writer permit exists only during controlled start and health check", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { marker, permit } = await fixture(t);
  const result = await withWriterStartPermit({ marker, permit, action: async () => {
    assert.equal((await stat(permit)).mode & 0o777, 0o600);
    assert.match(await readFile(permit, "utf8"), /writer-start-v1/);
    assert.match(await readFile(marker, "utf8"), /migration-incomplete/);
    return "healthy";
  } });
  assert.equal(result, "healthy");
  await assertWriterPermitAbsent(permit);
  assert.match(await readFile(marker, "utf8"), /migration-incomplete/);
});

test("OPS-07: failed health removes permit and duplicate permit blocks startup", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { marker, permit } = await fixture(t);
  await assert.rejects(withWriterStartPermit({ marker, permit, action: async () => {
    throw new Error("candidate unhealthy");
  } }), /candidate unhealthy/);
  await assertWriterPermitAbsent(permit);
  await writeFile(permit, "stale\n");
  await assert.rejects(withWriterStartPermit({ marker, permit, action: async () => {} }), /EEXIST/);
  assert.equal(await readFile(permit, "utf8"), "stale\n");
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectInstalledWriterGuards } from "../scripts/release/installed-writer-guard-preflight.mjs";
import { MANAGED_APP_UNITS, MANAGED_DROP_IN } from "../scripts/release/stage-managed-unit-overrides.mjs";
import { stageWriterBootGuard, WRITER_GUARD_DROP_IN } from "../scripts/release/writer-boot-guard.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-loaded-writers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const unitDirectory = path.join(root, "units");
  await stageWriterBootGuard({ outputDir: unitDirectory });
  for (const unit of MANAGED_APP_UNITS) await writeFile(path.join(unitDirectory, unit), "[Unit]\nDescription=test\n");
  await writeFile(path.join(unitDirectory, "dp-beget-mcp-oauth-spike.service.d", "10-dp012-dcr.conf"),
    "[Service]\nWorkingDirectory=/opt/legacy\n");
  const showUnit = async (unit, managed = false) => {
    const directory = path.join(unitDirectory, `${unit}.d`);
    const paths = unit === "dp-beget-mcp-oauth-spike.service" ? [path.join(directory, "10-dp012-dcr.conf")] : [];
    paths.push(path.join(directory, WRITER_GUARD_DROP_IN));
    if (managed) paths.push(path.join(directory, MANAGED_DROP_IN));
    return `LoadState=loaded\nFragmentPath=${path.join(unitDirectory, unit)}\nDropInPaths=${paths.join(" ")}\n`;
  };
  return { unitDirectory, showUnit };
}

test("OPS-07: exact four writer guards must be loaded by systemd", { skip: process.getuid?.() !== 0 }, async t => {
  const options = await fixture(t);
  const report = await inspectInstalledWriterGuards(options);
  assert.deepEqual(report.guardedUnits, MANAGED_APP_UNITS);
  await assert.rejects(inspectInstalledWriterGuards({ ...options,
    showUnit: async unit => (await options.showUnit(unit)).replace("DropInPaths=", "DropInPaths=/another.conf ") }),
  /exclusive writer guard/);
  await assert.rejects(inspectInstalledWriterGuards({ ...options,
    showUnit: async unit => (await options.showUnit(unit)).replace("LoadState=loaded", "LoadState=not-found") }),
  /exclusive writer guard/);
});

test("OPS-07: managed phase permits only the expected later managed drop-in", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  await inspectInstalledWriterGuards({ ...options, managed: true,
    showUnit: unit => options.showUnit(unit, true) });
  await assert.rejects(inspectInstalledWriterGuards({ ...options, managed: true }), /exclusive writer guard/);
});

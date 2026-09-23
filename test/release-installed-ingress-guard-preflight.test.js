import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { INGRESS_UNITS, stageIngressBootGuard } from "../scripts/release/ingress-boot-guard.mjs";
import { inspectInstalledIngressGuard } from "../scripts/release/installed-ingress-guard-preflight.mjs";

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "dp-loaded-guard-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const unitDirectory = path.join(base, "units");
  await stageIngressBootGuard({ outputDir: unitDirectory });
  for (const unit of INGRESS_UNITS) await writeFile(path.join(unitDirectory, unit), "[Unit]\nDescription=Fixture\n");
  const show = async unit => `LoadState=loaded\nFragmentPath=${path.join(unitDirectory, unit)}\n` +
    `DropInPaths=${path.join(unitDirectory, `${unit}.d`, "90-dp-r0004-migration-guard.conf")}\n`;
  return { unitDirectory, show };
}

test("OPS-07: systemd reports the exact sole guard loaded for all dedicated ingress units", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { unitDirectory, show } = await fixture(t);
  const result = await inspectInstalledIngressGuard({ unitDirectory, showUnit: show });
  assert.deepEqual(result.guardedUnits, INGRESS_UNITS);
});

test("OPS-07: missing reload, extra override, wrong fragment and tampered guard fail closed", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { unitDirectory, show } = await fixture(t);
  for (const replacement of ["DropInPaths=", "DropInPaths=/etc/systemd/system/extra.conf",
    "FragmentPath=/etc/systemd/system/wrong.service", "LoadState=not-found"]) {
    const modified = async unit => unit === INGRESS_UNITS[0]
      ? (await show(unit)).replace(new RegExp(`^${replacement.split("=")[0]}=.*$`, "m"), replacement)
      : show(unit);
    await assert.rejects(inspectInstalledIngressGuard({ unitDirectory, showUnit: modified }), /exclusive guard/);
  }
  await writeFile(path.join(unitDirectory, `${INGRESS_UNITS[1]}.d`, "90-dp-r0004-migration-guard.conf"),
    "[Unit]\nConditionPathExists=/tmp/unsafe\n");
  await assert.rejects(inspectInstalledIngressGuard({ unitDirectory, showUnit: show }), /Unexpected guard/);
});

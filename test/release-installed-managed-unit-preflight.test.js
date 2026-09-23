import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectInstalledManagedUnits } from "../scripts/release/installed-managed-unit-preflight.mjs";
import { MANAGED_APP_UNITS, MANAGED_DROP_IN, stageManagedUnitOverrides } from
  "../scripts/release/stage-managed-unit-overrides.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-managed-preflight-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseRoot = path.join(root, "releases");
  await mkdir(releaseRoot);
  const unitDirectory = path.join(root, "units");
  await stageManagedUnitOverrides({ outputDir: unitDirectory, releaseRoot });
  for (const unit of MANAGED_APP_UNITS) {
    await writeFile(path.join(unitDirectory, unit), `[Service]\nUser=dp-${unit}\n`);
  }
  const show = async unit => {
    const managed = path.join(unitDirectory, `${unit}.d`, MANAGED_DROP_IN);
    const dropins = unit === "dp-beget-mcp-oauth-spike.service"
      ? `${path.join(unitDirectory, `${unit}.d`, "10-dp012-dcr.conf")} ${managed}` : managed;
    return `LoadState=loaded\nFragmentPath=${path.join(unitDirectory, unit)}\n` +
      `DropInPaths=${dropins}\nWorkingDirectory=${releaseRoot}/current\nUser=dp-service\n` +
      `KillMode=${unit === "dp-beget-session-host.service" ? "process" : "control-group"}\n`;
  };
  return { unitDirectory, releaseRoot, show };
}

test("OPS-07: systemd loaded four managed bindings and retains Session Host tmux kill mode", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  const report = await inspectInstalledManagedUnits({ ...options, showUnit: options.show });
  assert.deepEqual(report.units, MANAGED_APP_UNITS);
});

test("OPS-07: missing reload or extra override refuses managed service switch", {
  skip: process.getuid?.() !== 0
}, async t => {
  const options = await fixture(t);
  for (const [key, value] of [["DropInPaths", "/etc/systemd/system/other.conf"],
    ["WorkingDirectory", "/opt/dp-beget-bridge"], ["KillMode", "control-group"]]) {
    const showUnit = async unit => unit === "dp-beget-session-host.service"
      ? (await options.show(unit)).replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`)
      : options.show(unit);
    await assert.rejects(inspectInstalledManagedUnits({ ...options, showUnit }), /managed service binding/);
  }
});

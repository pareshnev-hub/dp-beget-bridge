import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { backupSystemdUnits } from "../scripts/release/backup-systemd-units.mjs";

const UNITS = ["dp-beget-session-host.service", "dp-beget-agent.service",
  "dp-beget-mcp.service", "dp-beget-mcp-oauth-spike.service"];

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "dp-unit-backup-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const unitDirectory = path.join(base, "units");
  await mkdir(unitDirectory);
  for (const unit of UNITS) await writeFile(path.join(unitDirectory, unit), `[Service]\nEnvironment=CANARY=private\n`);
  const dropin = path.join(unitDirectory, "dp-beget-mcp-oauth-spike.service.d", "10-dp012-dcr.conf");
  await mkdir(path.dirname(dropin));
  await writeFile(dropin, "[Service]\nWorkingDirectory=/opt/dp-beget-bridge-dp012-dcr\n");
  return { base, unitDirectory, dropin };
}

function show(unitDirectory, dropin, override = {}) {
  return async unit => {
    const fields = { LoadState: "loaded", FragmentPath: path.join(unitDirectory, unit),
      DropInPaths: unit === "dp-beget-mcp-oauth-spike.service" ? dropin : "",
      WorkingDirectory: unit === "dp-beget-mcp-oauth-spike.service"
        ? "/opt/dp-beget-bridge-dp012-dcr" : "/opt/dp-beget-bridge",
      User: unit.includes("session-host") ? "dp-preview" : unit.includes("agent") ? "dp-agent" : "dp-mcp",
      ...override[unit] };
    return Object.entries(fields).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
  };
}

test("OPS-07: first-migration snapshot preserves core units and the separate OAuth drop-in privately", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { base, unitDirectory, dropin } = await fixture(t);
  const outputDir = path.join(base, "snapshot");
  const manifest = await backupSystemdUnits({ outputDir, unitDirectory, inspectUnit: show(unitDirectory, dropin) });
  assert.equal(manifest.files.length, 5);
  assert.equal(manifest.files.filter(item => item.path.endsWith("10-dp012-dcr.conf")).length, 1);
  assert.doesNotMatch(JSON.stringify(manifest), /CANARY=private/);
  assert.equal((await stat(outputDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(outputDir, "files", "dp-beget-agent.service"))).mode & 0o777, 0o600);
  assert.match(await readFile(path.join(outputDir, "files", "dp-beget-agent.service"), "utf8"), /CANARY=private/);
  await assert.rejects(backupSystemdUnits({ outputDir, unitDirectory, inspectUnit: show(unitDirectory, dropin) }), /EEXIST/);
});

test("OPS-07: unexpected OAuth drop-in path fails before writing backup", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { base, unitDirectory, dropin } = await fixture(t);
  const outputDir = path.join(base, "rejected");
  const inspectUnit = show(unitDirectory, dropin,
    { "dp-beget-mcp-oauth-spike.service": { DropInPaths: "/etc/systemd/system/unrelated.conf" } });
  await assert.rejects(backupSystemdUnits({ outputDir, unitDirectory, inspectUnit }), /unrecognized drop-in/);
  await assert.rejects(stat(outputDir), /ENOENT/);
});

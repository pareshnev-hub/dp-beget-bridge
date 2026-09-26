import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { guardContent } from "../scripts/release/ingress-boot-guard.mjs";
import { writerGuardContent } from "../scripts/release/writer-boot-guard.mjs";

const exec = promisify(execFile);
async function systemctl(...args) {
  return exec("systemctl", args, { timeout: 15000, maxBuffer: 4096 });
}
async function state(unit) {
  const { stdout } = await systemctl("show", unit, "--property=ActiveState", "--no-pager");
  return stdout.trim();
}

// This CI-only probe installs unique disposable units on the runner's actual
// systemd manager. It never uses any real bridge unit or live Beget path.
test("OPS-07: loaded systemd guards gate actual ingress and writer service starts", async t => {
  if (process.env.DP_TEST_REAL_SYSTEMD !== "1" || process.getuid?.() !== 0) {
    t.skip("requires the disposable root systemd CI runner");
    return;
  }
  const prefix = `dp-r0004-probe-${randomUUID().slice(0, 8)}`;
  const ingress = `${prefix}-ingress.service`;
  const writer = `${prefix}-writer.service`;
  const unitDir = "/etc/systemd/system";
  const markerRoot = await mkdtemp("/var/lib/dp-r0004-probe-");
  const permitRoot = await mkdtemp("/run/dp-r0004-probe-");
  const marker = path.join(markerRoot, "migration-incomplete");
  const permit = path.join(permitRoot, "writer-start-allowed");
  t.after(async () => {
    for (const unit of [ingress, writer]) await systemctl("stop", unit).catch(() => {});
    for (const unit of [ingress, writer]) {
      await rm(path.join(unitDir, `${unit}.d`), { recursive: true, force: true });
      await rm(path.join(unitDir, unit), { force: true });
    }
    await systemctl("daemon-reload");
    for (const unit of [ingress, writer]) await systemctl("reset-failed", unit).catch(() => {});
    await rm(markerRoot, { recursive: true, force: true });
    await rm(permitRoot, { recursive: true, force: true });
  });
  for (const unit of [ingress, writer]) {
    await writeFile(path.join(unitDir, unit),
      `[Unit]\nDescription=Disposable R0004 guard probe ${unit}\n[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/usr/bin/true\n`,
      { flag: "wx", mode: 0o644 });
    await mkdir(path.join(unitDir, `${unit}.d`), { mode: 0o755 });
  }
  await writeFile(path.join(unitDir, `${ingress}.d`, "90-dp-r0004-migration-guard.conf"),
    guardContent(marker), { flag: "wx", mode: 0o644 });
  await writeFile(path.join(unitDir, `${writer}.d`, "80-dp-r0004-writer-guard.conf"),
    writerGuardContent(marker, permit), { flag: "wx", mode: 0o644 });
  await systemctl("daemon-reload");
  for (const unit of [ingress, writer]) await systemctl("start", unit);
  assert.equal(await state(ingress), "ActiveState=active");
  assert.equal(await state(writer), "ActiveState=active");

  await writeFile(marker, "incomplete\n");
  // Conditions are evaluated at start. Already-running units need explicit stops.
  assert.equal(await state(ingress), "ActiveState=active");
  assert.equal(await state(writer), "ActiveState=active");
  for (const unit of [ingress, writer]) await systemctl("stop", unit);
  for (const unit of [ingress, writer]) await systemctl("start", unit).catch(() => {});
  assert.equal(await state(ingress), "ActiveState=inactive");
  assert.equal(await state(writer), "ActiveState=inactive");

  await writeFile(permit, "temporary\n");
  await systemctl("start", writer);
  await systemctl("start", ingress).catch(() => {});
  assert.equal(await state(writer), "ActiveState=active");
  assert.equal(await state(ingress), "ActiveState=inactive");
  await systemctl("stop", writer);
  await rm(permit);
  await systemctl("start", writer).catch(() => {});
  assert.equal(await state(writer), "ActiveState=inactive");

  await rm(marker);
  for (const unit of [ingress, writer]) await systemctl("start", unit);
  assert.equal(await state(ingress), "ActiveState=active");
  assert.equal(await state(writer), "ActiveState=active");
});

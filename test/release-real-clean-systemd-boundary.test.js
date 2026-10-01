import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { CLEAN_INSTALL_UNIT_NAMES } from "../scripts/release/preflight-clean-install.mjs";
import { inspectCleanLoadedSystemdUnits } from
  "../scripts/release/inspect-clean-systemd-boundary.mjs";

const exec = promisify(execFile);
const unitDirectory = "/etc/systemd/system";
const core = CLEAN_INSTALL_UNIT_NAMES.slice(0, 3);
async function systemctl(...args) {
  return exec("systemctl", args, { timeout: 20000, maxBuffer: 4096 });
}

// Exact reserved names, but only on the disposable root CI manager. Never
// start the units; this proves the loaded view after a real daemon-reload.
test("OPS-01: clean units load disabled and inactive with exact identities", async t => {
  if (process.env.DP_TEST_REAL_SYSTEMD !== "1" || process.getuid?.() !== 0) {
    t.skip("requires a disposable root systemd CI runner");
    return;
  }
  for (const unit of CLEAN_INSTALL_UNIT_NAMES) {
    const { stdout } = await systemctl("show", unit, "--property=LoadState", "--no-pager");
    assert.equal(stdout.trim(), "LoadState=not-found", `Refusing existing ${unit}`);
    for (const filename of [path.join(unitDirectory, unit),
      path.join(unitDirectory, `${unit}.d`)]) {
      await assert.rejects(lstat(filename), { code: "ENOENT" });
    }
  }
  const releaseRoot = await mkdtemp("/var/lib/dp-clean-manager-");
  const created = [];
  t.after(async () => {
    for (const unit of [...core].reverse()) await systemctl("stop", unit).catch(() => {});
    for (const filename of created.reverse()) await rm(filename, { recursive: true, force: true });
    await systemctl("daemon-reload");
    for (const unit of core) await systemctl("reset-failed", unit).catch(() => {});
    await rm(releaseRoot, { recursive: true, force: true });
  });
  await mkdir(path.join(releaseRoot, "releases"));
  await symlink("releases", path.join(releaseRoot, "current"));
  const identityPlan = { workUser: "dp_clean_work", ipcGroup: "dp_clean_ipc",
    agentUser: "dp_clean_agent", mcpUser: "dp_clean_mcp" };
  const users = [identityPlan.workUser, identityPlan.agentUser, identityPlan.mcpUser];
  const groups = [identityPlan.ipcGroup, identityPlan.agentUser, identityPlan.mcpUser];
  for (const [index, unit] of core.entries()) {
    const filename = path.join(unitDirectory, unit);
    await writeFile(filename, `[Unit]\nDescription=Disposable clean ${unit}\n` +
      `[Service]\nType=oneshot\nRemainAfterExit=yes\nUser=${users[index]}\n` +
      `Group=${groups[index]}\nWorkingDirectory=${releaseRoot}/current\n` +
      `${index === 0 ? "KillMode=process\n" : ""}ExecStart=/usr/bin/true\n` +
      `[Install]\nWantedBy=multi-user.target\n`, { flag: "wx", mode: 0o644 });
    created.push(filename);
  }
  await systemctl("daemon-reload");
  const inspect = () => inspectCleanLoadedSystemdUnits({ unitDirectory,
    releaseRoot, identityPlan,
    inspectListeners: async () => ({ directPorts: "unoccupied" }) });
  assert.deepEqual(await inspect(), { localSystemd: "inactive-bound",
    directPorts: "unoccupied", publicIngress: "unproven" });
  const override = path.join(unitDirectory, `${core[1]}.d`);
  await mkdir(override);
  created.push(override);
  await writeFile(path.join(override, "99-override.conf"),
    "[Service]\nEnvironment=DP_TEST_OVERRIDE=1\n", { flag: "wx", mode: 0o644 });
  await systemctl("daemon-reload");
  await assert.rejects(inspect(), /active or overridden/);
  await rm(override, { recursive: true });
  // Start inert non-root dummy services on the disposable manager. The
  // production templates and route stay outside this fixture.
  await chmod(releaseRoot, 0o755);
  const dummyPlan = { workUser: "nobody", ipcGroup: "nogroup",
    agentUser: "www-data", mcpUser: "daemon" };
  const dummyUsers = [dummyPlan.workUser, dummyPlan.agentUser, dummyPlan.mcpUser];
  const dummyGroups = [dummyPlan.ipcGroup, dummyPlan.agentUser, dummyPlan.mcpUser];
  for (const [index, unit] of core.entries()) {
    await writeFile(path.join(unitDirectory, unit),
      `[Unit]\nDescription=Disposable clean ${unit}\n` +
      `[Service]\nType=oneshot\nRemainAfterExit=yes\nUser=${dummyUsers[index]}\n` +
      `Group=${dummyGroups[index]}\nWorkingDirectory=${releaseRoot}/current\n` +
      `${index === 0 ? "KillMode=process\n" : ""}ExecStart=/usr/bin/true\n` +
      `[Install]\nWantedBy=multi-user.target\n`);
  }
  await systemctl("daemon-reload");
  for (const unit of core) await systemctl("start", unit);
  const running = () => inspectCleanLoadedSystemdUnits({ unitDirectory,
    releaseRoot, identityPlan: dummyPlan, expectActive: true,
    inspectListeners: async () => { throw new Error("Active ports need health probes"); } });
  assert.deepEqual(await running(), { localSystemd: "active-bound",
    directPorts: "local-health-required", publicIngress: "unproven" });
  await systemctl("stop", core[1]);
  await assert.rejects(running(), /active or overridden/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { renderClosedCleanCaddyConfig } from "../scripts/release/inspect-clean-caddy-config.mjs";
import { inspectCleanCaddyProcess } from "../scripts/release/inspect-clean-caddy-process.mjs";
import { inspectCleanCaddySystemd } from "../scripts/release/inspect-clean-caddy-systemd.mjs";
import { inspectCleanCaddyHost } from "../scripts/release/inspect-clean-caddy-host.mjs";

const exec = promisify(execFile);

test("OPS-01: real non-root Caddy owns the admin socket and TCP 443 on a disposable Linux host", async t => {
  if (process.env.DP_TEST_REAL_CADDY_PROCESS !== "1" || process.platform !== "linux" || process.getuid?.() !== 0) {
    t.skip("requires explicitly enabled disposable root Caddy CI");
    return;
  }
  const ownerUid = Number(process.env.SUDO_UID), ownerGid = Number(process.env.SUDO_GID);
  assert.ok(Number.isSafeInteger(ownerUid) && ownerUid > 0);
  assert.ok(Number.isSafeInteger(ownerGid) && ownerGid > 0);
  // Never displace an existing public TLS service, even on the test runner.
  for (const table of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = await readFile(table, "utf8");
    assert.ok(!text.split("\n").slice(1).some(line => {
      const fields = line.trim().split(/\s+/);
      return fields[1]?.endsWith(":01BB") && fields[3] === "0A";
    }), "Refusing an occupied TCP 443");
  }
  const executable = "/usr/bin/caddy";
  const originalCaps = (await exec("getcap", [executable])).stdout.trim();
  await exec("setcap", ["cap_net_bind_service=ep", executable]);
  t.after(async () => {
    if (originalCaps) await exec("setcap", [originalCaps.slice(executable.length).trim(), executable]);
    else await exec("setcap", ["-r", executable]);
  });
  const root = await mkdtemp("/tmp/dp-caddy-process-");
  const adminSocket = path.join(root, "admin.sock");
  const configPath = path.join(root, "config.json");
  const config = renderClosedCleanCaddyConfig({ domain: "bridge.example.invalid", adminSocket });
  // Local process/socket fixture only: no certificate issuance or claim of
  // public HTTPS acceptance. The full closed profile is tested separately.
  config.apps.http.servers.dp_clean.automatic_https = { disable: true };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await chown(configPath, ownerUid, ownerGid);
  for (const directory of ["data", "settings"]) {
    const filename = path.join(root, directory);
    await mkdir(filename, { mode: 0o700 });
    await chown(filename, ownerUid, ownerGid);
  }
  await chmod(root, 0o700);
  await chown(root, ownerUid, ownerGid);
  const child = spawn("/bin/sh", ["-c", 'umask 077; exec /usr/bin/caddy run --config "$1"',
    "caddy-test", configPath], {
    uid: ownerUid, gid: ownerGid, stdio: "ignore",
    env: { ...process.env, XDG_DATA_HOME: path.join(root, "data"),
      XDG_CONFIG_HOME: path.join(root, "settings") },
  });
  let spawnError;
  child.on("error", error => { spawnError = error; });
  const stopped = new Promise(resolve => child.once("exit", resolve));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const completed = await Promise.race([stopped.then(() => true), delay(3000).then(() => false)]);
      if (!completed) { child.kill("SIGKILL"); await stopped; }
    }
    await rm(root, { recursive: true, force: true });
  });
  const executableSha256 = createHash("sha256").update(await readFile(executable)).digest("hex");
  const options = { pid: child.pid, ownerUid, executable, executableSha256, adminSocket };
  let report, lastError;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    assert.equal(child.exitCode, null, "Caddy exited before process/socket inspection");
    try { report = await inspectCleanCaddyProcess(options); break; }
    catch (error) { lastError = error; }
    await delay(50);
  }
  if (!report) throw lastError;
  assert.equal(report.caddyProcess, "socket-listener-bound");
  assert.equal(report.publicIngress, "unproven");
  assert.equal(report.pid, child.pid);
  assert.equal(report.ownerUid, ownerUid);
  assert.notEqual(report.adminKernelInode, report.publicKernelInode);
  const repeat = await inspectCleanCaddyProcess(options);
  assert.deepEqual(repeat, report);
  await assert.rejects(inspectCleanCaddyProcess({ ...options, ownerUid: ownerUid + 1 }), /UIDs must match/);
  await assert.rejects(inspectCleanCaddyProcess({ ...options, executableSha256: "0".repeat(64) }), /pinned bytes/);
  child.kill("SIGTERM");
  await stopped;
  await assert.rejects(inspectCleanCaddyProcess(options), /unavailable|unidentified/);

  // Real manager identity plus host readers are rehearsed in a fresh network
  // namespace, so the runner's existing services/firewall are never changed.
  const namespacePath = process.env.DP_TEST_CADDY_NETNS;
  assert.match(namespacePath || "", /^\/run\/netns\/dp-clean-caddy-[a-z0-9-]+$/);
  const unitName = "dp-clean-caddy-test.service";
  const unitFile = `/run/systemd/system/${unitName}`;
  const override = `${unitFile}.d`;
  const systemctl = (...args) => exec("systemctl", args, { timeout: 20000, maxBuffer: 16384 });
  assert.equal((await systemctl("show", unitName, "--property=LoadState", "--value")).stdout.trim(), "not-found");
  await assert.rejects(lstat(unitFile), { code: "ENOENT" });
  await assert.rejects(lstat(override), { code: "ENOENT" });
  t.after(async () => {
    await systemctl("stop", unitName).catch(() => {});
    await rm(override, { recursive: true, force: true });
    await rm(unitFile, { force: true });
    await systemctl("daemon-reload");
    await systemctl("reset-failed", unitName).catch(() => {});
  });
  const unitText = `[Unit]\nDescription=Disposable Caddy identity fixture\n` +
    `[Service]\nType=simple\nUser=${ownerUid}\nGroup=${ownerGid}\nUMask=0077\n` +
    `NetworkNamespacePath=${namespacePath}\n` +
    `Environment=XDG_DATA_HOME=${root}/data XDG_CONFIG_HOME=${root}/settings\n` +
    `ExecStart=${executable} run --config ${configPath}\n`;
  await writeFile(unitFile, unitText, { mode: 0o644, flag: "wx" });
  await systemctl("daemon-reload");
  await systemctl("start", unitName);
  const pid = Number((await systemctl("show", unitName, "--property=MainPID", "--value")).stdout.trim());
  const serviceOptions = { ...options, pid, unitName, unitFile, ownerUser: String(ownerUid),
    unitFileSha256: createHash("sha256").update(unitText).digest("hex") };
  let serviceReport;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { serviceReport = await inspectCleanCaddySystemd(serviceOptions); break; }
    catch (error) { lastError = error; }
    await delay(50);
  }
  if (!serviceReport) throw lastError;
  assert.equal(serviceReport.caddySystemd, "main-process-bound");
  assert.deepEqual(await inspectCleanCaddySystemd(serviceOptions), serviceReport);
  const host = await inspectCleanCaddyHost(serviceReport);
  assert.equal(host.hostIngress, "dedicated-profile");
  assert.equal(host.socketOwners, "sole-process");
  assert.equal(host.publicIngress, "unproven");
  assert.deepEqual(await inspectCleanCaddyHost(serviceReport), host);
  await assert.rejects(inspectCleanCaddySystemd({ ...serviceOptions, unitFileSha256: "0".repeat(64) }), /pinned bytes/);
  await mkdir(override);
  await writeFile(path.join(override, "override.conf"), "[Service]\nEnvironment=DP_TEST_OVERRIDE=1\n", { mode: 0o644, flag: "wx" });
  await systemctl("daemon-reload");
  await assert.rejects(inspectCleanCaddySystemd(serviceOptions), /overridden/);
  await rm(override, { recursive: true });
  await systemctl("daemon-reload");
  assert.equal((await inspectCleanCaddySystemd(serviceOptions)).caddySystemd, "main-process-bound");
  // Add a real alternate public TCP listener and a real nft redirect in the
  // isolated namespace. Both must reject, then pass again after cleanup.
  const { createServer } = await import("node:net");
  const alternate = createServer();
  await new Promise((resolve, reject) => { alternate.once("error", reject); alternate.listen(8080, "0.0.0.0", resolve); });
  try { await assert.rejects(inspectCleanCaddyHost(serviceReport), /unsupported non-loopback/); }
  finally { await new Promise(resolve => alternate.close(resolve)); }
  await exec("nft", ["add", "table", "ip", "dp_test"]);
  try {
    await exec("nft", ["add", "chain", "ip", "dp_test", "prerouting", "{ type nat hook prerouting priority -100; }"]);
    await exec("nft", ["add", "rule", "ip", "dp_test", "prerouting", "tcp", "dport", "8443", "redirect", "to", "443"]);
    await assert.rejects(inspectCleanCaddyHost(serviceReport), /hook could reroute/);
  } finally { await exec("nft", ["delete", "table", "ip", "dp_test"]); }
  assert.deepEqual(await inspectCleanCaddyHost(serviceReport), host);
  await systemctl("stop", unitName);
  await assert.rejects(inspectCleanCaddySystemd(serviceOptions), /inactive|live service evidence unavailable/);
});

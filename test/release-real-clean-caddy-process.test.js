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

  // A purpose-built CA and leaf certificate prove the real production TLS
  // readers without internet access, insecure flags or a public-DNS claim.
  const domain = "bridge.example.invalid", expectedIp = "1.1.1.1";
  const caKey = path.join(root, "ca.key"), caCert = path.join(root, "ca.crt");
  const key = path.join(root, "leaf.key"), certificate = path.join(root, "leaf.crt");
  const csr = path.join(root, "leaf.csr"), extensions = path.join(root, "extensions.cnf");
  const openssl = args => exec("openssl", args, { timeout: 15000, maxBuffer: 16384 });
  await openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", caKey, "-out", caCert,
    "-subj", "/CN=DP-Disposable-Fixture-CA", "-days", "1", "-addext", "basicConstraints=critical,CA:TRUE"]);
  await openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr,
    "-subj", `/CN=${domain}`]);
  await writeFile(extensions, `subjectAltName=DNS:${domain}\nbasicConstraints=critical,CA:FALSE\n` +
    "extendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n", { mode: 0o600 });
  await openssl(["x509", "-req", "-in", csr, "-CA", caCert, "-CAkey", caKey, "-CAcreateserial",
    "-out", certificate, "-days", "1", "-sha256", "-extfile", extensions]);
  await chmod(caKey, 0o600);
  for (const filename of [key, certificate]) {
    await chmod(filename, 0o600);
    await chown(filename, ownerUid, ownerGid);
  }
  const certificateFiles = { certificate, key };
  await writeFile(configPath, JSON.stringify(renderClosedCleanCaddyConfig({ domain, adminSocket, certificateFiles })));
  await systemctl("start", unitName);
  const tlsPid = Number((await systemctl("show", unitName, "--property=MainPID", "--value")).stdout.trim());
  const tlsOptions = { ...serviceOptions, pid: tlsPid, domain, expectedIp, certificateFiles };
  const client = path.resolve("scripts/integration/clean-caddy-https-client.mjs");
  const runClient = (input, ca = caCert) => exec(process.execPath,
    [client, "--fixture-options", JSON.stringify(input)], { timeout: 30000, maxBuffer: 4096,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: ca } });
  let tlsReport;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { tlsReport = await runClient(tlsOptions); break; }
    catch (error) { lastError = error; }
    await delay(100);
  }
  if (!tlsReport) {
    // This exact public-test address lives only in our fresh isolated
    // namespace. Bounded route JSON contains no real host/user credentials.
    const route = await exec("ip", ["-j", "-4", "route", "get", expectedIp], { timeout: 5000, maxBuffer: 4096 });
    t.diagnostic(`Disposable route format: ${route.stdout.trim()}`);
    throw lastError;
  }
  assert.deepEqual(JSON.parse(tlsReport.stdout), { caddySystemd: "main-process-bound",
    caddyProcess: "socket-listener-bound", hostIngress: "dedicated-profile", caddyConfig: "closed-profile",
    localAddress: "host-bound", localRoute: "local-loopback", policyRules: "default-ipv4",
    publicResponse: "closed-upstream", publicIngress: "unproven", tls: "real-fixture-ca", dns: "simulated" });
  await assert.rejects(runClient(tlsOptions, ""), error => error.code === 1);
  await assert.rejects(runClient({ ...tlsOptions, scenario: "wrong-hostname" }), error => error.code === 1);
  // Mutate only the explicitly disposable namespace. These failures occur
  // before any HTTPS request to the now-unassigned fixture address.
  await exec("ip", ["addr", "del", `${expectedIp}/32`, "dev", "dp-public-test"]);
  try { await assert.rejects(runClient(tlsOptions), error => error.code === 1 && /address binding/.test(error.stderr)); }
  finally { await exec("ip", ["addr", "add", `${expectedIp}/32`, "dev", "dp-public-test"]); }
  await exec("ip", ["-4", "rule", "add", "priority", "100", "lookup", "main"]);
  try { await assert.rejects(runClient(tlsOptions), error => error.code === 1 && /policy routing/.test(error.stderr)); }
  finally { await exec("ip", ["-4", "rule", "del", "priority", "100", "lookup", "main"]); }
  assert.deepEqual(JSON.parse((await runClient(tlsOptions)).stdout), JSON.parse(tlsReport.stdout));
  // Prepare the actual signed private install in the runner's initial
  // network namespace (npm needs connectivity), then its guarded worker
  // joins this disposable namespace for the actual Caddy/TLS inspection.
  // A distinct existing non-root work identity avoids reusing Caddy's UID.
  const joinedOptions = { ...tlsOptions, namespacePath, caCert };
  let installed;
  try {
    installed = await exec("nsenter", ["--net=/proc/1/ns/net", "--", process.execPath,
      "--test", "test/release-real-clean-private-install.test.js"], { timeout: 180000, maxBuffer: 65536,
      env: { ...process.env, SUDO_UID: "65534", SUDO_GID: "65534",
        DP_TEST_REAL_PRIVATE_INSTALL: "1", DP_TEST_REAL_CLEAN_OAUTH_STAGING: "1",
        DP_TEST_REAL_CLEAN_OAUTH_OWNER: "1", DP_TEST_REAL_CLEAN_OAUTH_COMPOSED: "1",
        DP_TEST_REAL_CLEAN_PRIVATE_ENTRY: "1", DP_TEST_REAL_CLEAN_STARTUP: "0",
        DP_TEST_CADDY_INSTALL_ROUTE_JSON: JSON.stringify(joinedOptions) } });
  } catch {
    throw new Error("Joined signed-install/Caddy fixture failed; nested output withheld");
  }
  assert.match(installed.stdout, /^# pass 1$/m); assert.match(installed.stdout, /^# fail 0$/m);
  assert.match(installed.stdout, /^# skipped 0$/m);
  const line = installed.stdout.split("\n").find(value => value.startsWith('# {"commit":') && value.includes('"proxy":"actual-Caddy-systemd-host"'));
  assert.ok(line, "Joined signed-install/Caddy bounded report missing");
  const joined = JSON.parse(line.slice(2));
  assert.match(joined.commit, /^[0-9a-f]{40}$/); assert.match(joined.artifactSha256, /^[0-9a-f]{64}$/);
  assert.match(joined.policySha256, /^[0-9a-f]{64}$/); assert.equal(joined.installRoute, "signed-install-bound");
  assert.equal(joined.publicIngress, "unproven");
  t.diagnostic(JSON.stringify(joined));
  await systemctl("stop", unitName);
  t.diagnostic("Real Caddy/systemd/host/TLS/config/closed HTTPS rehearsal and joined actual signed private installation passed; DNS simulated; production ingress unproven");
});

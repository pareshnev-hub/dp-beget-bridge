// Fault injection only on the explicitly disposable signed-install CI host.
// Not an installer/recovery API and never a production firewall operation.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { lstat, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { readCleanInstallJournal } from "../release/clean-install-journal.mjs";
import { loadCleanInstallAuthConfiguration } from "../release/clean-install-auth-profile.mjs";
import { inspectCleanRunningSystemd } from "../release/inspect-clean-systemd-boundary.mjs";
import { pauseAdmission, resumeAdmission, verifyAdmissionPause } from "../release/admission-pause.mjs";
import { localReleaseHealthProbes, waitForAdmissionDrain } from "../release/wait-admission-drain.mjs";
import { oauthDefaults } from "../../packages/auth/src/oauth-spike.js";
import { AGENT_CONTEXT_HEADER, createAgentContext } from "../../packages/auth/src/agent-context.js";

const exec = promisify(execFile);
const units = ["dp-beget-session-host.service", "dp-beget-agent.service", "dp-beget-mcp.service"];
const scopes = "terminal:read terminal:execute terminal:input terminal:close files:read files:write files:delete";
const systemctl = (...args) => exec("systemctl", args, { timeout: 20000, maxBuffer: 8192 });

export async function rehearseCleanPrivateAutonomy({ journalPath, trustDir } = {}) {
  if (process.env.DP_TEST_REAL_PRIVATE_AUTONOMY !== "1" || process.env.DP_TEST_REAL_PRIVATE_INSTALL !== "1" ||
      process.platform !== "linux" || process.getuid?.() !== 0) throw new Error("Explicit disposable root autonomy fixture required");
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js")]);
  const journal = await readCleanInstallJournal(journalPath), plan = journal.identityPlan;
  if (journal.phase !== "startup-ready" || !/^\/var\/lib\/dp-ci-release-[a-f0-9]{10}$/.test(journal.releaseRoot) ||
      !/^\/srv\/dp-ci-work-[a-f0-9]{10}$/.test(plan.allowedRoot) ||
      !/^dpci_m_[a-f0-9]{10}$/.test(plan.mcpUser) || !/^dpci_a_[a-f0-9]{10}$/.test(plan.agentUser)) {
    throw new Error("Autonomy fixture does not own this private installation");
  }
  assert.equal((await inspectCleanRunningSystemd({ journalPath, trustDir })).localSystemd, "active-bound");
  assert.equal((await verifyAdmissionPause()).paused, true);
  const profile = await loadCleanInstallAuthConfiguration({ workspace: journal.workspace,
    manifestSha256: journal.manifestSha256, trustDir });
  assert.equal(profile.authMode, "oauth"); assert.equal(profile.executionProfile, "full-shell");
  assert.match(await readFile("/etc/dp-beget-bridge/agent.env", "utf8"), /^DP_TELEMETRY_ENABLED=false$/m);
  // These runtime drop-in paths must be absent before we own them. Fault
  // injection happens only after all signed startup/recovery proofs passed.
  const runtimeDirectories = units.flatMap(unit => [
    `/run/systemd/system/${unit}.d`, `/run/systemd/system.control/${unit}.d`]);
  for (const directory of runtimeDirectories) await assert.rejects(lstat(directory), { code: "ENOENT" });
  const probeUnit = `dp-ci-autonomy-${randomBytes(5).toString("hex")}.service`;
  assert.equal((await systemctl("show", probeUnit, "--property=LoadState", "--value")).stdout.trim(), "not-found");
  const control = http.createServer((_request, response) => { response.writeHead(204); response.end(); });
  await new Promise((resolve, reject) => { control.once("error", reject); control.listen(0, "127.0.0.2", resolve); });
  const controlUrl = `http://127.0.0.2:${control.address().port}/control`;
  const source = `try { const r=await fetch(${JSON.stringify(controlUrl)},{signal:AbortSignal.timeout(1500)});
    console.log(r.status===204?'egress-open':'unexpected'); } catch { console.log('egress-blocked'); }`;
  let client, sessionId, stage = "egress-control", restricted = false;
  const origin = "http://127.0.0.1:8788";
  let token, clientId;
  const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  const postForm = (path, body) => request(`${origin}${path}`, { method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
  async function call(name, args = {}) {
    const response = await client.callTool({ name, arguments: args });
    if (response.isError || !response.structuredContent) throw new Error("Autonomy capability failed");
    return response.structuredContent;
  }
  try {
    const initial = await exec("runuser", ["-u", plan.mcpUser, "--", process.execPath,
      "--input-type=module", "--eval", source], { timeout: 5000, maxBuffer: 4096 });
    assert.equal(initial.stdout.trim(), "egress-open");
    const blocked = await exec("systemd-run", ["--unit", probeUnit, "--wait", "--pipe", "--collect",
      `--property=User=${plan.mcpUser}`, `--property=Group=${plan.mcpUser}`,
      "--property=IPAddressDeny=any", "--property=IPAddressAllow=127.0.0.1/32",
      process.execPath, "--input-type=module", "--eval", source], { timeout: 15000, maxBuffer: 8192 });
    assert.equal(blocked.stdout.trim(), "egress-blocked", "effective cgroup BPF egress denial required");
    stage = "runtime-egress-denial";
    restricted = true;
    for (const unit of units) {
      await systemctl("set-property", "--runtime", unit, "IPAddressDeny=any", "IPAddressAllow=127.0.0.1/32");
      assert.equal((await systemctl("show", unit, "--property=IPAddressAllow", "--value")).stdout.trim(), "127.0.0.1/32");
      const denied = (await systemctl("show", unit, "--property=IPAddressDeny", "--value")).stdout.trim().split(/\s+/).sort();
      assert.deepEqual(denied, ["0.0.0.0/0", "::/0"]);
    }
    await resumeAdmission({ assertHealthy: () => waitForAdmissionDrain({ probes: localReleaseHealthProbes() }) });
    stage = "local-oauth-consent";
    const registration = await request(`${origin}/oauth/register`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [oauthDefaults.chatGptRedirectUri], token_endpoint_auth_method: "none" }) });
    assert.equal(registration.status, 201); clientId = (await registration.json()).client_id;
    assert.ok(typeof clientId === "string" && clientId.startsWith("dcr_"));
    const verifier = randomBytes(48).toString("base64url"), authorize = new URL(`${origin}/oauth/authorize`);
    for (const [key, value] of Object.entries({ response_type: "code", client_id: clientId,
      redirect_uri: oauthDefaults.chatGptRedirectUri, resource: `https://${plan.domain}/mcp`, scope: scopes,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state: "ci-autonomy" })) {
      authorize.searchParams.set(key, value);
    }
    const consent = await request(authorize); assert.equal(consent.status, 200);
    const html = await consent.text(), transaction = /name="transaction" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
    assert.ok(transaction); assert.ok(html.includes("Authorize full shell access"));
    // Synthetic owner/browser consent on the disposable fixture only. No
    // production grant/owner is adopted and no remote callback is followed.
    const approved = await postForm("/oauth/authorize", { transaction, approval_secret: profile.approvalSecret });
    assert.equal(approved.status, 303);
    const callback = new URL(approved.headers.get("location"));
    const exchange = await postForm("/oauth/token", { grant_type: "authorization_code", code: callback.searchParams.get("code"),
      client_id: clientId, redirect_uri: oauthDefaults.chatGptRedirectUri, resource: `https://${plan.domain}/mcp`, code_verifier: verifier });
    assert.equal(exchange.status, 200); token = (await exchange.json()).access_token;
    assert.ok(typeof token === "string" && token.length > 32);
    client = new Client({ name: "disposable-direct-autonomy", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    stage = "bridge-status";
    assert.equal((await call("get_bridge_status")).product, "DP Beget Bridge");
    stage = "terminal-open";
    sessionId = (await call("open_terminal", { cwd: plan.allowedRoot, label: "Disposable autonomy fixture" })).id;
    assert.ok(typeof sessionId === "string");
    // Real Agent upload route with a synthetic narrow OAuth service context.
    // MCP's external attachment fetch is deliberately outside this egress-
    // denied fixture; no repair credential or private URL bypass is used.
    stage = "agent-upload-workspace";
    const uploadedName = "autonomy-ci-upload/nested/source.txt";
    const uploadBytes = "ci-upload-content\n";
    const uploadTo = target => {
      const route = `/v1/files/content?${new URLSearchParams({ path: `${plan.allowedRoot}/${target}` })}`;
      return request(`http://127.0.0.1:8787${route}`, { method: "PUT",
        headers: { authorization: `Bearer ${profile.oauthAgentToken}`, "content-type": "application/octet-stream",
          [AGENT_CONTEXT_HEADER]: createAgentContext({ secret: profile.contextSecret,
            authorization: { ownerId: profile.ownerId, grantId: "ci-upload-roundtrip",
              scopes: ["files:write"], executionProfile: "full-shell" }, method: "PUT", path: route }) }, body: uploadBytes });
    };
    const uploaded = await uploadTo(uploadedName);
    assert.equal(uploaded.status, 201);
    const receipt = await uploaded.json();
    assert.equal(receipt.size, Buffer.byteLength(uploadBytes));
    assert.equal(receipt.sha256, createHash("sha256").update(uploadBytes).digest("hex"));
    const rootStat = await lstat(plan.allowedRoot), uploadStat = await lstat(`${plan.allowedRoot}/${uploadedName}`);
    assert.equal(uploadStat.mode & 0o7777, 0o660); assert.equal(uploadStat.gid, rootStat.gid);
    assert.notEqual(uploadStat.uid, rootStat.uid);
    for (const directory of ["autonomy-ci-upload", "autonomy-ci-upload/nested"]) {
      const stat = await lstat(`${plan.allowedRoot}/${directory}`);
      assert.equal(stat.mode & 0o7777, 0o2770); assert.equal(stat.gid, rootStat.gid);
    }
    stage = "agent-upload-acl-refusal";
    await exec("setfacl", ["-m", "d:u:65534:rwx", plan.allowedRoot], { timeout: 5000, maxBuffer: 4096 });
    try { assert.equal((await uploadTo("acl-rejected.txt")).status, 409); }
    finally { await exec("setfacl", ["-k", plan.allowedRoot], { timeout: 5000, maxBuffer: 4096 }); }
    await assert.rejects(lstat(`${plan.allowedRoot}/acl-rejected.txt`), { code: "ENOENT" });
    const name = "autonomy-ci-probe.txt";
    stage = "terminal-command";
    const command = await call("run_terminal_command", { session_id: sessionId, idempotency_key: "ci-autonomy-command",
      command: `cat ${uploadedName} && printf 'ci-upload-written\\n' >> ${uploadedName} && ` +
        `printf 'ci-autonomy-content\\n' > ${name} && printf 'ci-autonomy-ready\\n'`, wait_ms: 50 });
    assert.ok(typeof command.operationId === "string");
    stage = "terminal-completion";
    let complete = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const operation = await call("get_terminal_operation", { session_id: sessionId, operation_id: command.operationId });
      if (operation.status === "SUCCEEDED") { complete = true; break; }
      await delay(100);
    }
    assert.equal(complete, true);
    stage = "terminal-output";
    const read = await call("read_terminal", { session_id: sessionId, cursor: 0, max_bytes: 8192 });
    assert.ok(read.output.includes("ci-autonomy-ready"));
    assert.ok(read.output.includes("ci-upload-content"));
    assert.equal(await readFile(`${plan.allowedRoot}/${uploadedName}`, "utf8"), "ci-upload-content\nci-upload-written\n");
    const privateCanary = `${plan.allowedRoot}/existing-private-canary.txt`;
    assert.equal((await lstat(privateCanary)).mode & 0o777, 0o600);
    assert.equal(await readFile(privateCanary, "utf8"), "private-existing-workspace-fixture\n");
    stage = "file-list";
    const files = await call("list_files", { path: plan.allowedRoot });
    assert.ok(files.entries.some(entry => entry.name === name));
    stage = "file-download-descriptor";
    const download = await call("download_file", { path: `${plan.allowedRoot}/${name}` });
    const link = new URL(download.uri);
    assert.equal(link.origin, `https://${plan.domain}`);
    // Local transport rehearsal only: preserve the exact issued download
    // path, never forward its token to another origin or print the URL.
    stage = "file-download-bytes";
    const bytes = await request(`${origin}${link.pathname}`); assert.equal(bytes.status, 200);
    assert.equal(await bytes.text(), "ci-autonomy-content\n");
    stage = "terminal-close";
    await call("close_terminal", { session_id: sessionId });
    stage = "terminal-purge";
    await call("purge_terminal", { session_id: sessionId }); sessionId = undefined;
    stage = "file-delete";
    await call("delete_path", { path: `${plan.allowedRoot}/${name}`, recursive: false });
    await call("delete_path", { path: `${plan.allowedRoot}/${uploadedName}`, recursive: false });
    await call("delete_path", { path: `${plan.allowedRoot}/autonomy-ci-upload/nested`, recursive: false });
    await call("delete_path", { path: `${plan.allowedRoot}/autonomy-ci-upload`, recursive: false });
    stage = "revocation";
    assert.equal((await postForm("/oauth/revoke", { token, token_type_hint: "access_token", client_id: clientId })).status, 200);
    const revoked = await request(`${origin}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    assert.equal(revoked.status, 401);
    const os = await readFile("/etc/os-release", "utf8");
    assert.match(os, /^ID=ubuntu$/m); assert.match(os, /^VERSION_ID="24\.04"$/m);
    return { commit: journal.commit, artifactSha256: journal.artifactSha256,
      environment: { os: "Ubuntu 24.04", node: process.versions.node,
        systemd: (await systemctl("--version")).stdout.split("\n")[0],
        tmux: (await exec("tmux", ["-V"], { timeout: 5000, maxBuffer: 4096 })).stdout.trim() },
      externalEgress: "denied", enforcement: "effective-control-probe", telemetry: "off",
      oauth: "synthetic-owner-consent", terminal: "pass", fileDownload: "pass", revocation: "pass",
      agentUploadTerminalRoundtrip: "pass", uploadTransport: "local-Agent-synthetic-OAuth-context",
      publicTransport: "unproven", scope: "disposable signed local Direct runtime; not real-client or public release acceptance" };
  } catch {
    throw new Error(`Disposable Direct autonomy is unproven at ${stage}; credentials withheld`);
  } finally {
    if (sessionId && client) await client.callTool({ name: "close_terminal", arguments: { session_id: sessionId } }).catch(() => {});
    await client?.close().catch(() => {});
    await pauseAdmission();
    if (restricted) for (const unit of units) {
      await systemctl("set-property", "--runtime", unit, "IPAddressDeny=", "IPAddressAllow=").catch(() => {});
    }
    if (restricted) for (const directory of runtimeDirectories) await rm(directory, { recursive: true, force: true });
    await systemctl("daemon-reload");
    await systemctl("stop", probeUnit).catch(() => {});
    await systemctl("reset-failed", probeUnit).catch(() => {});
    await new Promise(resolve => control.close(resolve));
  }
}

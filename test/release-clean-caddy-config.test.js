import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { renderClosedCleanCaddyConfig, validateClosedCleanCaddyConfig,
  inspectClosedCleanCaddyConfig, inspectCleanCaddyRoute } from "../scripts/release/inspect-clean-caddy-config.mjs";

const options = { domain: "bridge.example.com", adminSocket: "/run/caddy-private/admin.sock" };
const bytes = config => Buffer.from(JSON.stringify(config));

test("OPS-01: real Caddy provisions the closed bootstrap JSON without starting it", async t => {
  if (process.env.DP_TEST_CADDY_PROFILE !== "1") {
    t.skip("requires the disposable Caddy validation CI job");
    return;
  }
  const directory = await mkdtemp("/tmp/dp-caddy-validate-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "closed.json");
  await writeFile(filename, bytes(renderClosedCleanCaddyConfig(options)), { mode: 0o600 });
  const exec = promisify(execFile);
  const result = await exec("caddy", ["version"], { timeout: 10000, maxBuffer: 4096 });
  t.diagnostic(`Caddy validator: ${result.stdout.trim()}`);
  await exec("caddy", ["validate", "--config", filename], {
    timeout: 20000, maxBuffer: 16384,
    env: { ...process.env, XDG_DATA_HOME: path.join(directory, "data"),
      XDG_CONFIG_HOME: path.join(directory, "config") },
  });
});

test("OPS-01: closed Caddy snapshot has no proxy handler and is not ingress authorization", () => {
  const config = renderClosedCleanCaddyConfig(options);
  const report = validateClosedCleanCaddyConfig(bytes(config), options);
  assert.equal(report.caddyConfig, "closed-profile");
  assert.equal(report.publicIngress, "unproven");
  assert.match(report.configSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(config).includes("reverse_proxy"), false);
  const reordered = { apps: config.apps, admin: config.admin };
  assert.deepEqual(validateClosedCleanCaddyConfig(bytes(reordered), options), report);
});

test("OPS-01: additional routes, handlers, apps, listeners and wrong domains fail closed", () => {
  const mutations = [
    c => { c.apps.http.servers.dp_clean.routes[0].handle[0] = { handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:8788" }] }; },
    c => { c.apps.http.servers.dp_clean.routes.push({ handle: [{ handler: "file_server" }] }); },
    c => { c.apps.http.servers.other = c.apps.http.servers.dp_clean; },
    c => { c.apps.http.servers.dp_clean.listen.push(":8080"); },
    c => { c.apps.http.servers.dp_clean.routes[0].match[0].host = ["other.example.com"]; },
    c => { c.apps.http.servers.dp_clean.routes[0].match[0].path = ["/health"]; },
    c => { c.apps.http.servers.dp_clean.routes[0].handle[0].status_code = 200; },
    c => { c.apps.http.servers.dp_clean.routes[0].handle[0].body = "{http.request.uri}"; },
    c => { c.apps.http.servers.dp_clean.errors = { routes: [] }; },
    c => { c.apps.http.servers.dp_clean.protocols.push("h3"); },
    c => { c.apps.http.servers.dp_clean.logs = {}; },
    c => { c.apps.layer4 = {}; },
    c => { c.admin.listen = "localhost:2019"; },
    c => { c.admin.remote = {}; },
  ];
  for (const mutate of mutations) {
    const config = renderClosedCleanCaddyConfig(options);
    mutate(config);
    assert.throws(() => validateClosedCleanCaddyConfig(bytes(config), options), /does not match/);
  }
  for (const value of [Buffer.alloc(65537), Buffer.alloc(0), "{}", Buffer.from("{"), bytes(null)]) {
    assert.throws(() => validateClosedCleanCaddyConfig(value, options), /Invalid|does not match/);
  }
});

test("OPS-01: Caddy snapshot renderer refuses socket URLs, traversal and unsafe hostnames", () => {
  for (const adminSocket of ["http://localhost:2019", "admin.sock", "/run/../admin.sock", "/run/socket|0666"]) {
    assert.throws(() => renderClosedCleanCaddyConfig({ ...options, adminSocket }), /socket path/);
  }
  assert.throws(() => renderClosedCleanCaddyConfig({ ...options, domain: "*.example.com" }), /hostname/);
});

test("OPS-01: explicit TLS file profile binds exactly one certificate/key pair and rejects substitutions", () => {
  const input = { ...options, certificateFiles: { certificate: "/etc/caddy/bridge.crt", key: "/etc/caddy/bridge.key" } };
  const config = renderClosedCleanCaddyConfig(input);
  assert.deepEqual(config.apps.tls.certificates.load_files, [input.certificateFiles]);
  assert.equal(validateClosedCleanCaddyConfig(bytes(config), input).caddyConfig, "closed-profile");
  assert.throws(() => validateClosedCleanCaddyConfig(bytes(config), options), /does not match/);
  const wrong = structuredClone(config);
  wrong.apps.tls.certificates.load_files[0].key = "/etc/caddy/other.key";
  assert.throws(() => validateClosedCleanCaddyConfig(bytes(wrong), input), /does not match/);
  for (const certificateFiles of [null, [], {}, { certificate: "relative", key: "/etc/caddy/key" },
    { certificate: "/etc/../cert", key: "/etc/caddy/key" },
    { certificate: "/etc/caddy/key", key: "/etc/caddy/key" },
    { certificate: options.adminSocket, key: "/etc/caddy/key" },
    { ...input.certificateFiles, tags: ["unexpected"] }]) {
    assert.throws(() => renderClosedCleanCaddyConfig({ ...options, certificateFiles }), /required|distinct/);
  }
});

test("OPS-01: protected Caddy snapshots bracket the host-bound public observation", async () => {
  const report = validateClosedCleanCaddyConfig(bytes(renderClosedCleanCaddyConfig(options)), options);
  const calls = [];
  const fixture = { ...options, expectedIp: "1.1.1.1", ownerUid: 1001,
    inspectConfig: async () => { calls.push("config"); return report; },
    probePublic: async binding => { calls.push("public"); return { ...binding, path: "/mcp",
      status: 502, publicResponse: "closed-upstream", publicIngress: "unproven" }; } };
  assert.equal((await inspectCleanCaddyRoute(fixture)).publicIngress, "unproven");
  assert.deepEqual(calls, ["config", "public", "config"]);
  let count = 0;
  await assert.rejects(inspectCleanCaddyRoute({ ...fixture,
    inspectConfig: async () => ++count === 1 ? report : { ...report, configSha256: "a".repeat(64) } }),
  /changed around/);
  await assert.rejects(inspectCleanCaddyRoute({ ...fixture,
    probePublic: async () => ({ domain: "wrong.example.com" }) }), /response binding/);
  await assert.rejects(inspectCleanCaddyRoute({ ...fixture,
    inspectConfig: async () => ({ ...report, publicIngress: "closed-exclusive" }),
    probePublic: async () => assert.fail("unproven config reached public probe") }), /configuration is unproven/);
});

test("OPS-01: real Unix admin reader is GET-only, bounded, private and checks permissions twice", async t => {
  if (!process.getuid || process.getuid() === 0) {
    t.skip("requires a non-root Unix test identity");
    return;
  }
  const directory = await mkdtemp("/tmp/dp-caddy-test-");
  // macOS resolves /tmp through /private; use the actual path in the proof.
  const { realpath } = await import("node:fs/promises");
  const parent = await realpath(directory);
  await chmod(parent, 0o700);
  const adminSocket = path.join(parent, "admin.sock");
  const input = { ...options, adminSocket, ownerUid: process.getuid() };
  const config = renderClosedCleanCaddyConfig(input);
  let handler = (_request, response) => response.end(bytes(config));
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push([request.method, request.url, request.headers.host]);
    response.setHeader("Content-Type", "application/json");
    handler(request, response);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(parent, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(adminSocket, resolve);
  });
  await chmod(adminSocket, 0o600);
  assert.equal((await inspectClosedCleanCaddyConfig(input)).caddyConfig, "closed-profile");
  assert.deepEqual(requests, [["GET", "/config/", "localhost"]]);
  for (const change of [
    (_req, res) => { res.statusCode = 302; res.setHeader("Location", "http://elsewhere/"); res.end("{}"); },
    (_req, res) => { res.setHeader("Content-Type", "text/plain"); res.end("{}"); },
    (_req, res) => { res.setHeader("Content-Encoding", "gzip"); res.end("{}"); },
    (_req, res) => res.end(Buffer.alloc(65537)),
    (_req, res) => { res.setHeader("Content-Length", 100); res.write("{}"); setImmediate(() => res.destroy()); },
  ]) {
    handler = change;
    await assert.rejects(inspectClosedCleanCaddyConfig(input), /read failed/);
  }
  handler = () => {};
  await assert.rejects(inspectClosedCleanCaddyConfig({ ...input, timeoutMs: 25 }), /read failed/);
  handler = (_req, res) => res.end(bytes(config));
  const count = requests.length;
  await chmod(adminSocket, 0o666);
  await assert.rejects(inspectClosedCleanCaddyConfig(input), /must be private/);
  await chmod(adminSocket, 0o600);
  await assert.rejects(inspectClosedCleanCaddyConfig({ ...input, ownerUid: 0 }), /non-root/);
  await assert.rejects(inspectClosedCleanCaddyConfig({ ...input, ownerUid: input.ownerUid + 1 }), /must be private/);
  assert.equal(requests.length, count);
  const alias = path.join(parent, "alias.sock");
  await symlink(adminSocket, alias);
  await assert.rejects(inspectClosedCleanCaddyConfig({ ...input, adminSocket: alias }), /must be private/);
  handler = (_req, res) => {
    chmod(parent, 0o755).then(() => res.end(bytes(config))).catch(error => res.destroy(error));
  };
  await assert.rejects(inspectClosedCleanCaddyConfig(input), /must be private/);
  assert.ok(requests.every(([method, url]) => method === "GET" && url === "/config/"));
});

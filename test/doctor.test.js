import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("LOG-06: doctor reports failures without secrets, paths, or unhandled rejections", async () => {
  const canary = "doctor-canary-secret-value";
  await assert.rejects(
    execFileAsync(process.execPath, ["scripts/doctor.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DP_DOCTOR_WAIT_MS: "50",
        DP_AGENT_URL: "http://127.0.0.1:1",
        DP_MCP_URL: "http://127.0.0.1:1",
        DP_AGENT_TOKEN: canary,
        DP_MCP_ACCESS_TOKEN: canary,
        DP_SESSION_HOST_SOCKET: `/tmp/${canary}.sock`,
        DP_AGENT_SYSTEMD_UNIT: "dp-beget-doctor-missing-agent.service",
        DP_MCP_SYSTEMD_UNIT: "dp-beget-doctor-missing-mcp.service",
        DP_SESSION_HOST_SYSTEMD_UNIT: "dp-beget-doctor-missing-session-host.service",
      },
      encoding: "utf8",
    }),
    (error) => {
      assert.match(error.stdout, /FAIL  Agent health:/);
      assert.match(error.stdout, /FAIL  MCP health:/);
      assert.match(error.stdout, /FAIL  Session Host health:/);
      assert.doesNotMatch(`${error.stdout}${error.stderr}`, /triggerUncaughtException/);
      assert.doesNotMatch(`${error.stdout}${error.stderr}`, new RegExp(canary));
      assert.doesNotMatch(error.stdout, /\/tmp\//);
      return true;
    },
  );
});

test("R0004: doctor JSON bounds unresponsive probes and redacts errors", async t => {
  const server = http.createServer(() => {});
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const canary = "sensitive-diagnostic-canary";
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const started = Date.now();
  await assert.rejects(execFileAsync(process.execPath, ["scripts/doctor.mjs", "--json"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DP_DOCTOR_WAIT_MS: "75",
      DP_AGENT_URL: `${endpoint}/${canary}`,
      DP_MCP_URL: `${endpoint}/${canary}`,
      DP_AGENT_TOKEN: canary,
      DP_SESSION_HOST_SOCKET: `/tmp/${canary}.sock`,
      DP_AGENT_SYSTEMD_UNIT: "dp-beget-doctor-missing-agent.service",
      DP_MCP_SYSTEMD_UNIT: "dp-beget-doctor-missing-mcp.service",
      DP_SESSION_HOST_SYSTEMD_UNIT: "dp-beget-doctor-missing-session-host.service",
    },
    encoding: "utf8",
    timeout: 3000,
  }), error => {
    const report = JSON.parse(error.stdout);
    assert.equal(report.format, "dp-beget-doctor-v1");
    assert.equal(report.checks.find(check => check.name === "Agent health").ok, false);
    assert.equal(report.checks.find(check => check.name === "MCP health").ok, false);
    assert.equal(report.checks.find(check => check.name === "Session state schema").ok, false);
    assert.doesNotMatch(`${error.stdout}${error.stderr}`, new RegExp(canary));
    return true;
  });
  assert.ok(Date.now() - started < 3000);
});

test("R0004: doctor reports managed version, schema and disk without local paths", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-doctor-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const commit = "a".repeat(40);
  const release = path.join(root, "releases", `0.1.0-${commit}`);
  await fs.mkdir(release, { recursive: true });
  await fs.writeFile(path.join(release, "package.json"),
    JSON.stringify({ name: "dp-beget-bridge", version: "0.1.0" }));
  await fs.symlink(`releases/0.1.0-${commit}`, path.join(root, "current"));
  const databasePath = path.join(root, "state.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA user_version = 2");
  database.close();
  await assert.rejects(execFileAsync(process.execPath, ["scripts/doctor.mjs", "--json"], {
    cwd: process.cwd(), encoding: "utf8",
    env: { ...process.env, DP_DOCTOR_WAIT_MS: "50", DP_AGENT_URL: "http://127.0.0.1:1",
      DP_MCP_URL: "http://127.0.0.1:1", DP_DOCTOR_RELEASE_ROOT: root,
      DP_DOCTOR_STATE_DATABASE: databasePath, DP_DOCTOR_STATE_DIR: root,
      DP_AGENT_SYSTEMD_UNIT: "dp-beget-doctor-missing-agent.service",
      DP_MCP_SYSTEMD_UNIT: "dp-beget-doctor-missing-mcp.service",
      DP_SESSION_HOST_SYSTEMD_UNIT: "dp-beget-doctor-missing-session-host.service" },
  }), error => {
    const checks = JSON.parse(error.stdout).checks;
    assert.equal(checks.find(check => check.name === "Installed release").detail,
      `0.1.0 ${commit}`);
    assert.equal(checks.find(check => check.name === "Session state schema").detail, "v2");
    assert.equal(checks.find(check => check.name === "Local disk reserve").detail, "ok");
    assert.doesNotMatch(error.stdout, new RegExp(root));
    return true;
  });
});

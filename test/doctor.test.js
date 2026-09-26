import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
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
    assert.doesNotMatch(`${error.stdout}${error.stderr}`, new RegExp(canary));
    return true;
  });
  assert.ok(Date.now() - started < 3000);
});

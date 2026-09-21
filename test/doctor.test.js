import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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

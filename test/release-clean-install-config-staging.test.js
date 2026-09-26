import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderCleanInstallConfig, stageCleanInstallConfig } from "../scripts/release/stage-clean-install-config.mjs";

test("OPS-01: clean Direct config isolates Session Host from credentials", () => {
  const agentToken = "a".repeat(64);
  const mcpToken = "b".repeat(64);
  const config = renderCleanInstallConfig({ domain: "Bridge.Example.Com", allowedRoot: "/srv/operator",
    agentToken, mcpToken });
  assert.doesNotMatch(config["session-host.env"], /TOKEN|SECRET|TELEMETRY/);
  assert.match(config["agent.env"], /DP_TELEMETRY_ENABLED=false\n/);
  assert.match(config["agent.env"], new RegExp(`DP_AGENT_TOKEN=${agentToken}\\n`));
  assert.doesNotMatch(config["agent.env"], /DP_MCP_ACCESS_TOKEN/);
  assert.match(config["mcp.env"], new RegExp(`DP_MCP_ACCESS_TOKEN=${mcpToken}\\n`));
  assert.match(config["mcp.env"], /DP_PUBLIC_URL=https:\/\/bridge\.example\.com\n/);
  assert.throws(() => renderCleanInstallConfig({ domain: "bridge.example.com",
    allowedRoot: "/srv/operator", agentToken, mcpToken: agentToken }), /Separate/);
  assert.throws(() => renderCleanInstallConfig({ domain: "bridge.example.com",
    allowedRoot: "/srv/a b", agentToken, mcpToken }), /Unsafe/);
});

test("OPS-01: staged secrets stay private and cannot overwrite an existing directory", {
  skip: process.getuid?.() !== 0
}, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "dp-clean-config-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const parent = path.join(base, "private");
  await mkdir(parent, { mode: 0o700 });
  const stageDir = path.join(parent, "config");
  const args = { stageDir, domain: "bridge.example.com", allowedRoot: "/srv/operator" };
  const result = await stageCleanInstallConfig(args);
  assert.deepEqual(result.files, ["session-host.env", "agent.env", "mcp.env"]);
  assert.equal(JSON.stringify(result).includes("DP_AGENT_TOKEN"), false);
  assert.equal((await stat(stageDir)).mode & 0o777, 0o700);
  for (const file of result.files) assert.equal((await stat(path.join(stageDir, file))).mode & 0o777, 0o600);
  const agent = await readFile(path.join(stageDir, "agent.env"), "utf8");
  const mcp = await readFile(path.join(stageDir, "mcp.env"), "utf8");
  const token = agent.match(/^DP_AGENT_TOKEN=([0-9a-f]{64})$/m)?.[1];
  assert.ok(token);
  assert.ok(mcp.includes(`DP_AGENT_TOKEN=${token}\n`));
  assert.notEqual(mcp.match(/^DP_MCP_ACCESS_TOKEN=([0-9a-f]{64})$/m)?.[1], token);
  await assert.rejects(stageCleanInstallConfig(args), /EEXIST/);
  await chmod(parent, 0o755);
  await assert.rejects(stageCleanInstallConfig({ ...args, stageDir: path.join(parent, "unsafe") }),
    /private and root-owned/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { renderCleanInstallConfig, stageCleanInstallConfig } from "../scripts/release/stage-clean-install-config.mjs";
import { prepareCleanInstall } from "../scripts/release/prepare-clean-install.mjs";

const exec = promisify(execFile);
const envFields = content => Object.fromEntries(content.trimEnd().split("\n").map(line => {
  const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1)];
}));

test("OPS-01: clean Direct config isolates Session Host from credentials", () => {
  const agentToken = "a".repeat(64);
  const mcpToken = "b".repeat(64);
  const config = renderCleanInstallConfig({ domain: "Bridge.Example.Com", allowedRoot: "/srv/operator",
    agentToken, mcpToken });
  assert.doesNotMatch(config["session-host.env"], /TOKEN|SECRET|TELEMETRY/);
  assert.match(config["agent.env"], /DP_TELEMETRY_ENABLED=false\n/);
  assert.match(config["agent.env"], /DP_FILE_WORKSPACE_SHARING=ipc-group\n/);
  assert.match(config["agent.env"], new RegExp(`DP_AGENT_TOKEN=${agentToken}\\n`));
  assert.doesNotMatch(config["agent.env"], /DP_MCP_ACCESS_TOKEN/);
  assert.match(config["mcp.env"], new RegExp(`DP_MCP_ACCESS_TOKEN=${mcpToken}\\n`));
  assert.match(config["mcp.env"], /DP_PUBLIC_URL=https:\/\/bridge\.example\.com\n/);
  assert.throws(() => renderCleanInstallConfig({ domain: "bridge.example.com",
    allowedRoot: "/srv/operator", agentToken, mcpToken: agentToken }), /Separate/);
  assert.throws(() => renderCleanInstallConfig({ domain: "bridge.example.com",
    allowedRoot: "/srv/a b", agentToken, mcpToken }), /Unsafe/);
});

test("OPS-01/AUTH-09: clean OAuth config uses restricted Agent context and actual service loaders", async () => {
  const inputs = { domain: "Bridge.Example.Com", allowedRoot: "/srv/operator", authMode: "oauth",
    agentToken: "a".repeat(64), oauthAgentToken: "b".repeat(64),
    contextSecret: "c".repeat(64), approvalSecret: "d".repeat(64) };
  for (const executionProfile of ["files-read", "full-shell"]) {
    const config = renderCleanInstallConfig({ ...inputs, executionProfile });
    assert.doesNotMatch(config["session-host.env"], /TOKEN|SECRET|OAUTH|OWNER/);
    const agent = envFields(config["agent.env"]), mcp = envFields(config["mcp.env"]);
    assert.equal(agent.DP_AGENT_TOKEN, inputs.agentToken);
    assert.equal(agent.DP_AGENT_OAUTH_TOKEN, mcp.DP_AGENT_TOKEN);
    assert.equal(agent.DP_AGENT_CONTEXT_SECRET, mcp.DP_AGENT_CONTEXT_SECRET);
    assert.notEqual(agent.DP_AGENT_TOKEN, mcp.DP_AGENT_TOKEN);
    assert.ok(!config["mcp.env"].includes(inputs.agentToken));
    assert.equal(mcp.DP_MCP_ACCESS_TOKEN, undefined);
    assert.equal(mcp.DP_OAUTH_ISSUER, "https://bridge.example.com");
    assert.equal(mcp.DP_OAUTH_RESOURCE, "https://bridge.example.com/mcp");
    assert.equal(mcp.DP_OWNER_ID, "owner-primary");
    assert.equal(agent.DP_TELEMETRY_ENABLED, "false");
    const agentLoaded = await exec(process.execPath, ["--input-type=module", "-e",
      "import {loadConfig} from './apps/agent/src/config.js';const c=loadConfig();console.log(JSON.stringify({scoped:!!c.oauthToken&&!!c.contextSecret,isolated:c.token!==c.oauthToken,telemetry:c.telemetryEnabled}));"],
    { env: { PATH: process.env.PATH, ...agent }, timeout: 5000 });
    assert.deepEqual(JSON.parse(agentLoaded.stdout), { scoped: true, isolated: true, telemetry: false });
    const mcpLoaded = await exec(process.execPath, ["--input-type=module", "-e",
      "import {loadMcpConfig} from './apps/mcp/src/config.js';const c=loadMcpConfig();console.log(JSON.stringify({auth:c.authMode,staticToken:!!c.accessToken,owner:c.oauth.ownerId,profile:c.oauth.executionProfile,scopes:c.oauth.scopes}));"],
    { env: { PATH: process.env.PATH, ...mcp }, timeout: 5000 });
    const loaded = JSON.parse(mcpLoaded.stdout);
    assert.equal(loaded.auth, "oauth"); assert.equal(loaded.staticToken, false);
    assert.equal(loaded.owner, "owner-primary"); assert.equal(loaded.profile, executionProfile);
    if (executionProfile === "files-read") assert.deepEqual(loaded.scopes, ["files:read"]);
    else assert.ok(loaded.scopes.includes("terminal:execute") && loaded.scopes.includes("files:delete"));
  }
  for (const overrides of [{ contextSecret: inputs.oauthAgentToken }, { mcpToken: "e".repeat(64) },
    { ownerId: "owner\nDP_INJECTED=true" }, { executionProfile: "unknown-profile" }, { authMode: "unknown" }]) {
    assert.throws(() => renderCleanInstallConfig({ ...inputs, ...overrides }));
  }
});

test("OPS-01: invalid OAuth selection cannot reach clean-install preflight or preparation", {
  skip: process.getuid?.() !== 0
}, async () => {
  let invoked = false;
  await assert.rejects(prepareCleanInstall({ workspace: "/private/candidate", workspaceParent: "/private",
    authMode: "oauth", ownerId: "bad\nowner",
    inspect: async () => { invoked = true; }, prepare: async () => { invoked = true; } }), /authorization profile/);
  assert.equal(invoked, false);
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
  const oauthDir = path.join(parent, "oauth-config");
  const oauth = await stageCleanInstallConfig({ ...args, stageDir: oauthDir, authMode: "oauth" });
  assert.deepEqual(oauth, { files: ["session-host.env", "agent.env", "mcp.env"], mode: "private-staging" });
  assert.equal((await stat(path.join(oauthDir, "mcp.env"))).mode & 0o777, 0o600);
  const oauthMcp = await readFile(path.join(oauthDir, "mcp.env"), "utf8");
  assert.match(oauthMcp, /DP_MCP_AUTH_MODE=oauth\n/);
  assert.doesNotMatch(oauthMcp, /DP_MCP_ACCESS_TOKEN=/);
  await assert.rejects(stageCleanInstallConfig(args), /EEXIST/);
  await chmod(parent, 0o755);
  await assert.rejects(stageCleanInstallConfig({ ...args, stageDir: path.join(parent, "unsafe") }),
    /private and root-owned/);
});

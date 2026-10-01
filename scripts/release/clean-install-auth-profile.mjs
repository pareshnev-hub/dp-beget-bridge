import path from "node:path";
import { verifyCleanInstallManifest } from "./clean-install-manifest.mjs";
import { inspectCleanInstallIdentityPlan } from "./clean-install-identity-plan.mjs";
import { readRegularFile } from "./verify-artifact.mjs";
import { renderCleanInstallConfig } from "./stage-clean-install-config.mjs";

function fields(source) {
  const output = {};
  if (!source.endsWith("\n")) throw new Error("Invalid clean authorization configuration");
  for (const line of source.trimEnd().split("\n")) {
    const index = line.indexOf("=");
    const key = line.slice(0, index);
    if (index < 1 || !/^[A-Z][A-Z0-9_]*$/.test(key) || Object.hasOwn(output, key)) {
      throw new Error("Invalid clean authorization configuration");
    }
    output[key] = line.slice(index + 1);
  }
  return output;
}

// Internal installer credential reader. Never print/serialize its result or
// pass credentials in argv. The public inspector below returns no secrets.
export async function loadCleanInstallAuthConfiguration({ workspace, manifestSha256, trustDir } = {}) {
  await verifyCleanInstallManifest({ workspace, manifestSha256, trustDir });
  const plan = await inspectCleanInstallIdentityPlan({ workspace, manifestSha256, trustDir });
  const config = {};
  for (const name of ["session-host.env", "agent.env", "mcp.env"]) {
    config[name] = (await readRegularFile(path.join(workspace, "clean-install", "config", name), 16 * 1024)).toString("utf8");
  }
  const agent = fields(config["agent.env"]), mcp = fields(config["mcp.env"]);
  const authMode = mcp.DP_MCP_AUTH_MODE;
  if (!["static", "oauth"].includes(authMode)) throw new Error("Unproven clean authorization mode");
  const inputs = { domain: plan.domain, allowedRoot: plan.allowedRoot, authMode,
    agentToken: agent.DP_AGENT_TOKEN,
    ...(authMode === "oauth" ? {
      oauthAgentToken: agent.DP_AGENT_OAUTH_TOKEN, contextSecret: agent.DP_AGENT_CONTEXT_SECRET,
      approvalSecret: mcp.DP_OAUTH_STAGING_APPROVAL_SECRET,
      ownerId: mcp.DP_OWNER_ID, executionProfile: mcp.DP_OAUTH_EXECUTION_PROFILE,
    } : { mcpToken: mcp.DP_MCP_ACCESS_TOKEN }) };
  const rendered = renderCleanInstallConfig(inputs);
  if (Object.keys(config).some(name => config[name] !== rendered[name])) {
    throw new Error("Clean authorization configuration differs from its exact supported profile");
  }
  await verifyCleanInstallManifest({ workspace, manifestSha256, trustDir });
  return { ...inputs, plan };
}

export async function inspectCleanInstallAuthProfile(options) {
  const profile = await loadCleanInstallAuthConfiguration(options);
  return { authMode: profile.authMode, ...(profile.authMode === "oauth"
    ? { ownerId: profile.ownerId, executionProfile: profile.executionProfile } : {}) };
}

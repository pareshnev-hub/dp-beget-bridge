import path from "node:path";
import { validateHostname } from "./host-preflight.mjs";
import { verifyCleanInstallManifest } from "./clean-install-manifest.mjs";
import { readRegularFile } from "./verify-artifact.mjs";

function singleLine(content, key) {
  const found = content.split("\n").filter(line => line.startsWith(`${key}=`));
  if (found.length !== 1 || !found[0].slice(key.length + 1)) {
    throw new Error("Invalid staged clean-install identity field");
  }
  return found[0].slice(key.length + 1);
}

function identity(value) {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(value) || value === "root") {
    throw new Error("Unsafe staged clean-install identity");
  }
  return value;
}

function safePath(value) {
  if (!path.isAbsolute(value) || path.normalize(value) !== value ||
      !/^\/[a-zA-Z0-9_./-]+$/.test(value) || value.split("/").includes("..")) {
    throw new Error("Unsafe staged clean-install path");
  }
  return value;
}

// Read only the exact six files bound to the private candidate manifest.
// Secrets are never returned; the plan binds only service identities and paths.
export async function inspectCleanInstallIdentityPlan({ workspace, manifestSha256,
  trustDir } = {}) {
  await verifyCleanInstallManifest({ workspace, manifestSha256, trustDir });
  const staged = path.join(workspace, "clean-install");
  const read = async (kind, name) => (await readRegularFile(
    path.join(staged, kind, name), 16 * 1024)).toString("utf8");
  const [session, agent, mcp, sessionConfig, agentConfig, mcpConfig] = await Promise.all([
    read("units", "dp-beget-session-host.service"), read("units", "dp-beget-agent.service"),
    read("units", "dp-beget-mcp.service"), read("config", "session-host.env"),
    read("config", "agent.env"), read("config", "mcp.env")
  ]);
  const workUser = identity(singleLine(session, "User"));
  const workGroup = identity(singleLine(session, "SupplementaryGroups"));
  const ipcGroup = identity(singleLine(session, "Group"));
  const agentUser = identity(singleLine(agent, "User"));
  const mcpUser = identity(singleLine(mcp, "User"));
  if (singleLine(agent, "Group") !== agentUser ||
      singleLine(mcp, "Group") !== mcpUser ||
      singleLine(agent, "SupplementaryGroups") !== ipcGroup ||
      singleLine(session, "KillMode") !== "process" ||
      new Set([workUser, agentUser, mcpUser]).size !== 3 ||
      new Set([workGroup, agentUser, mcpUser, ipcGroup]).size !== 4) {
    throw new Error("Staged clean-install service identities disagree");
  }
  const allowedRoot = safePath(singleLine(sessionConfig, "DP_ALLOWED_ROOTS"));
  if (singleLine(agentConfig, "DP_ALLOWED_ROOTS") !== allowedRoot ||
      singleLine(session, "ReadWritePaths") !== `/var/lib/dp-beget-bridge ${allowedRoot}` ||
      singleLine(agent, "ReadWritePaths") !== `/var/lib/dp-beget-bridge-agent ${allowedRoot}`) {
    throw new Error("Staged clean-install work directories disagree");
  }
  const suffix = "/current";
  const workdir = singleLine(session, "WorkingDirectory");
  if (!workdir.endsWith(suffix)) throw new Error("Staged clean-install release link is invalid");
  const releaseRoot = safePath(workdir.slice(0, -suffix.length));
  if ([agent, mcp].some(unit => singleLine(unit, "WorkingDirectory") !== workdir)) {
    throw new Error("Staged clean-install release bindings disagree");
  }
  const publicUrl = singleLine(mcpConfig, "DP_PUBLIC_URL");
  if (!publicUrl.startsWith("https://")) throw new Error("Staged clean-install public URL must use HTTPS");
  const domain = validateHostname(publicUrl.slice("https://".length));
  if (publicUrl !== `https://${domain}`) throw new Error("Staged clean-install public URL is not canonical");
  await verifyCleanInstallManifest({ workspace, manifestSha256, trustDir });
  return { workUser, workGroup, ipcGroup, agentUser, mcpUser,
    allowedRoot, releaseRoot, domain };
}

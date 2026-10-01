import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_TRUST_DIR } from "./pin-release-key.mjs";
import { verifyCleanInstallManifest, writeCleanInstallManifest } from "./clean-install-manifest.mjs";
import { preflightCleanInstall } from "./preflight-clean-install.mjs";
import { prepareRelease } from "./prepare-release.mjs";
import { stageCleanInstallConfig, validateCleanInstallAuthSelection } from "./stage-clean-install-config.mjs";
import { stageCleanInstallUnits } from "./stage-clean-install-units.mjs";

// The only mutation is a new private candidate workspace. No live path,
// account, unit, port or reverse-proxy route is touched here.
export async function prepareCleanInstall({ artifact, manifest, signature, domain,
  expectedIp, workUser, workGroup, agentUser, mcpUser, ipcGroup, allowedRoot,
  authMode = "static", ownerId = "owner-primary", executionProfile = "files-read",
  workspaceParent, workspace, releaseRoot, trustDir = DEFAULT_TRUST_DIR,
  inspect = preflightCleanInstall, prepare = prepareRelease,
  stageUnits = stageCleanInstallUnits, stageConfig = stageCleanInstallConfig,
  writeManifest = writeCleanInstallManifest,
  verifyManifest = verifyCleanInstallManifest } = {}) {
  if (process.getuid?.() !== 0 || typeof workspace !== "string" ||
      typeof workspaceParent !== "string" || !path.isAbsolute(workspace) ||
      path.normalize(workspace) !== workspace || path.dirname(workspace) !== workspaceParent ||
      path.basename(workspace).startsWith(".")) {
    throw new Error("Root and a new direct child of the private workspace parent are required");
  }
  validateCleanInstallAuthSelection({ authMode, ownerId, executionProfile });
  const inputs = { artifact, manifest, signature, domain, expectedIp, workUser,
    workGroup, agentUser, mcpUser, ipcGroup, allowedRoot, workspaceParent, releaseRoot, trustDir };
  const proof = await inspect(inputs);
  if (!/^[0-9a-f]{64}$/.test(proof?.candidate?.sha256 || "")) {
    throw new Error("Clean-install candidate proof is incomplete");
  }
  // Preparation creates and owns the new workspace only on success. On a
  // failed mkdir/EEXIST it must never clean an unrelated existing directory.
  const candidate = await prepare({ artifact, manifest, signature, workspace, trustDir });
  try {
    if (candidate.sha256 !== proof.candidate.sha256) {
      throw new Error("Signed candidate changed after clean-install preflight");
    }
    const staging = path.join(workspace, "clean-install");
    await mkdir(staging, { mode: 0o700 });
    const units = await stageUnits({ artifact, manifest, signature, trustDir,
      stageDir: path.join(staging, "units"), releaseRoot, allowedRoot, workUser,
      workGroup, agentUser, mcpUser, ipcGroup });
    if (units.sha256 !== candidate.sha256) {
      throw new Error("Signed service templates differ from prepared release");
    }
    const config = await stageConfig({ stageDir: path.join(staging, "config"), domain, allowedRoot,
      authMode, ownerId, executionProfile });
    if (JSON.stringify(units.units) !== JSON.stringify([
      "dp-beget-session-host.service", "dp-beget-agent.service", "dp-beget-mcp.service"]) ||
        JSON.stringify(config.files) !== JSON.stringify([
          "session-host.env", "agent.env", "mcp.env"])) {
      throw new Error("Clean-install staging inventory is incomplete");
    }
    const bound = await writeManifest({ workspace, artifactSha256: candidate.sha256, trustDir });
    await verifyManifest({ workspace, manifestSha256: bound.sha256, trustDir });
    return { version: candidate.version, commit: candidate.commit, sha256: candidate.sha256,
      manifestSha256: bound.sha256, workspace, units: units.units.length,
      configFiles: config.files.length,
      scope: "private candidate staging only; no service installation or exposure" };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

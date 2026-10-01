import { createHash } from "node:crypto";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { verifyCleanInstallManifest } from "./clean-install-manifest.mjs";
import { readRegularFile } from "./verify-artifact.mjs";
import { inspectCleanWorkspace } from "./clean-install-workspace.mjs";

const FILES = ["agent.env", "mcp.env", "session-host.env"];

export async function inspectInstalledCleanConfig({ configDir = "/etc/dp-beget-bridge",
  workspace, manifestSha256, trustDir, identityPlan, identities,
  inspectWorkspace = inspectCleanWorkspace,
  verify = verifyCleanInstallManifest } = {}) {
  if (typeof configDir !== "string" || !path.isAbsolute(configDir) ||
      path.normalize(configDir) !== configDir || configDir === "/" ||
      identities?.identities !== "journal-bound" || !identityPlan) {
    throw new Error("Bound service identities and absolute configuration directory are required");
  }
  await verify({ workspace, manifestSha256, trustDir });
  if ((await inspectWorkspace({ identityPlan, identities }))?.workspace !== "shared-private") {
    throw new Error("Installed clean workspace access is unproven");
  }
  const parent = path.dirname(configDir);
  const parentInfo = await stat(parent);
  const dir = await lstat(configDir);
  if (!parentInfo.isDirectory() || parentInfo.uid !== 0 ||
      (parentInfo.mode & 0o022) !== 0 || await realpath(parent) !== parent ||
      !dir.isDirectory() || dir.uid !== 0 || dir.nlink < 2 ||
      (dir.mode & 0o777) !== 0o711 || await realpath(configDir) !== configDir ||
      JSON.stringify((await readdir(configDir)).sort()) !== JSON.stringify(FILES)) {
    throw new Error("Installed configuration directory is untrusted");
  }
  const gids = { "agent.env": identities.agentGid, "mcp.env": identities.mcpGid,
    "session-host.env": identities.ipcGid };
  if (Object.values(gids).some(gid => !Number.isSafeInteger(gid) || gid < 1)) {
    throw new Error("Service group IDs are unproven");
  }
  for (const name of FILES) {
    const target = path.join(configDir, name);
    const info = await lstat(target);
    if (!info.isFile() || info.uid !== 0 || info.gid !== gids[name] ||
        info.nlink !== 1 || (info.mode & 0o777) !== 0o640 ||
        info.size < 1 || info.size > 16 * 1024) {
      throw new Error("Installed private configuration has invalid ownership or permissions");
    }
    const [actual, staged] = await Promise.all([
      readRegularFile(target, 16 * 1024),
      readRegularFile(path.join(workspace, "clean-install", "config", name), 16 * 1024)
    ]);
    if (actual.length !== info.size ||
        createHash("sha256").update(actual).digest("hex") !==
          createHash("sha256").update(staged).digest("hex")) {
      throw new Error("Installed private configuration differs from the bound candidate");
    }
  }
  await verify({ workspace, manifestSha256, trustDir });
  return { config: "bound-private", files: FILES.length };
}

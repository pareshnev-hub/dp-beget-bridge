import { constants } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const MANAGED_APP_UNITS = Object.freeze([
  "dp-beget-session-host.service", "dp-beget-agent.service",
  "dp-beget-mcp.service", "dp-beget-mcp-oauth-spike.service"
]);
export const MANAGED_DROP_IN = "90-dp-r0004-managed-release.conf";

export function managedUnitContent(releaseRoot) {
  if (!path.isAbsolute(releaseRoot || "") || path.normalize(releaseRoot) !== releaseRoot ||
      releaseRoot.includes("\n") || releaseRoot.includes("\r") || releaseRoot.includes("%") ||
      releaseRoot.includes("\\") || releaseRoot.includes(" ")) {
    throw new Error("Managed release root must be an unambiguous absolute path");
  }
  return `[Service]\nWorkingDirectory=${path.join(releaseRoot, "current")}\n`;
}

export async function stageManagedUnitOverrides({ outputDir, releaseRoot }) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to stage managed service overrides");
  const content = managedUnitContent(releaseRoot);
  if (!path.isAbsolute(outputDir || "") || path.normalize(outputDir) !== outputDir) {
    throw new Error("A normalized absolute output directory is required");
  }
  const parent = path.dirname(outputDir);
  const parentInfo = await stat(parent);
  const releaseInfo = await stat(releaseRoot);
  if ((await realpath(parent)) !== parent || parentInfo.uid !== 0 ||
      !parentInfo.isDirectory() || (parentInfo.mode & 0o022) !== 0 ||
      (await realpath(releaseRoot)) !== releaseRoot || !releaseInfo.isDirectory() ||
      releaseInfo.uid !== 0 || (releaseInfo.mode & 0o022) !== 0) {
    throw new Error("Staging and release roots must be trusted root-owned directories");
  }
  await mkdir(outputDir, { mode: 0o700 });
  for (const unit of MANAGED_APP_UNITS) {
    const directory = path.join(outputDir, `${unit}.d`);
    await mkdir(directory, { mode: 0o700 });
    const file = await open(path.join(directory, MANAGED_DROP_IN),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  const handle = await open(outputDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
  const parentHandle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parentHandle.sync(); } finally { await parentHandle.close(); }
  return { units: [...MANAGED_APP_UNITS], dropIn: MANAGED_DROP_IN,
    workingDirectory: path.join(releaseRoot, "current") };
}

import { createHash } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { verifyCleanInstallManifest } from "./clean-install-manifest.mjs";
import { CLEAN_INSTALL_UNIT_NAMES } from "./preflight-clean-install.mjs";
import { readRegularFile } from "./verify-artifact.mjs";

const FILES = CLEAN_INSTALL_UNIT_NAMES.slice(0, 3);

async function missing(filename) {
  try { await lstat(filename); throw new Error("Unexpected existing clean-install unit or drop-in"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

// File presence is not systemd activation. This checks only disk state; a
// later controller must separately prove inactive services and safe startup.
export async function inspectInstalledCleanUnits({ unitDirectory = "/etc/systemd/system",
  workspace, manifestSha256, trustDir,
  verify = verifyCleanInstallManifest } = {}) {
  if (typeof unitDirectory !== "string" || !path.isAbsolute(unitDirectory) ||
      path.normalize(unitDirectory) !== unitDirectory || unitDirectory === "/") {
    throw new Error("Absolute unit directory is required");
  }
  await verify({ workspace, manifestSha256, trustDir });
  const parent = await stat(unitDirectory);
  if (!parent.isDirectory() || parent.uid !== 0 || (parent.mode & 0o022) !== 0 ||
      await realpath(unitDirectory) !== unitDirectory) throw new Error("Untrusted systemd unit directory");
  for (const name of CLEAN_INSTALL_UNIT_NAMES) {
    await missing(path.join(unitDirectory, `${name}.d`));
    if (!FILES.includes(name)) await missing(path.join(unitDirectory, name));
  }
  for (const name of FILES) {
    const target = path.join(unitDirectory, name);
    const info = await lstat(target);
    if (!info.isFile() || info.uid !== 0 || info.gid !== 0 || info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o644 || info.size < 1 || info.size > 16 * 1024) {
      throw new Error("Installed clean-install unit is untrusted");
    }
    const [actual, staged] = await Promise.all([
      readRegularFile(target, 16 * 1024),
      readRegularFile(path.join(workspace, "clean-install", "units", name), 16 * 1024)
    ]);
    if (actual.length !== info.size ||
        createHash("sha256").update(actual).digest("hex") !==
          createHash("sha256").update(staged).digest("hex")) {
      throw new Error("Installed clean-install unit differs from the bound candidate");
    }
  }
  await verify({ workspace, manifestSha256, trustDir });
  return { units: "bound-files", files: FILES.length };
}

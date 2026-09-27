import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { CLEAN_INSTALL_UNIT_NAMES, inspectCleanInstallListeners } from "./preflight-clean-install.mjs";
import { inspectInstalledCleanUnits } from "./inspect-installed-clean-units.mjs";
import { inspectPromotedCleanRelease } from "./inspect-promoted-clean-release.mjs";
import { readCleanInstallJournal } from "./clean-install-journal.mjs";

const exec = promisify(execFile);
const KEYS = ["LoadState", "FragmentPath", "DropInPaths", "ActiveState", "UnitFileState",
  "WorkingDirectory", "User", "Group", "KillMode"];

async function systemctlShow(unit) {
  const { stdout } = await exec("systemctl", ["show", unit,
    `--property=${KEYS.join(",")}`, "--no-pager"], { timeout: 5000, maxBuffer: 4096 });
  return stdout;
}

function parse(output) {
  if (typeof output !== "string" || output.length > 4096) {
    throw new Error("Clean-install systemd inventory is unavailable");
  }
  const values = {};
  for (const line of output.trimEnd().split("\n")) {
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    if (separator < 1 || !KEYS.includes(key) || Object.hasOwn(values, key)) {
      throw new Error("Invalid clean-install systemd inventory");
    }
    values[key] = line.slice(separator + 1);
  }
  if (KEYS.some(key => !Object.hasOwn(values, key))) {
    throw new Error("Incomplete clean-install systemd inventory");
  }
  return values;
}

// Local boundary after daemon-reload and before starting the three core units.
// The public reverse-proxy route needs its own independent closed-ingress proof.
export async function inspectCleanSystemdBoundary({ journalPath, trustDir,
  unitDirectory = "/etc/systemd/system", showUnit = systemctlShow,
  inspectInstalled = inspectInstalledCleanUnits,
  inspectPointer = inspectPromotedCleanRelease,
  inspectListeners = inspectCleanInstallListeners } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to inspect clean systemd boundary");
  const journal = await readCleanInstallJournal(journalPath);
  if (journal.phase !== "pointer-ready") throw new Error("Clean pointer is not ready for systemd preflight");
  if ((await inspectInstalled({ unitDirectory, workspace: journal.workspace,
    manifestSha256: journal.manifestSha256, trustDir }))?.units !== "bound-files" ||
      (await inspectPointer({ journal, trustDir,
        requireCurrent: true }))?.release !== "signed-inert") {
    throw new Error("Clean-install unit files or release pointer are unproven");
  }
  const identities = journal.identityPlan;
  const users = [identities.workUser, identities.agentUser, identities.mcpUser];
  const groups = [identities.ipcGroup, identities.agentUser, identities.mcpUser];
  for (const [index, unit] of CLEAN_INSTALL_UNIT_NAMES.entries()) {
    const state = parse(await showUnit(unit));
    if (state.ActiveState !== "inactive" || state.DropInPaths !== "") {
      throw new Error(`Clean-install systemd unit is active or overridden: ${unit}`);
    }
    if (index < 3) {
      if (state.LoadState !== "loaded" ||
          state.FragmentPath !== path.join(unitDirectory, unit) ||
          state.UnitFileState !== "disabled" ||
          state.WorkingDirectory !== path.join(journal.releaseRoot, "current") ||
          state.User !== users[index] || state.Group !== groups[index] ||
          (index === 0 && state.KillMode !== "process")) {
        throw new Error(`Clean-install systemd binding is unproven: ${unit}`);
      }
    } else if (state.LoadState !== "not-found" || state.FragmentPath !== "") {
      throw new Error(`Clean-install ingress unit exists: ${unit}`);
    }
  }
  if ((await inspectListeners())?.directPorts !== "unoccupied") {
    throw new Error("Clean-install Direct service ports are occupied");
  }
  if ((await inspectPointer({ journal, trustDir,
    requireCurrent: true }))?.release !== "signed-inert") {
    throw new Error("Clean-install release changed during systemd preflight");
  }
  return { localSystemd: "inactive-bound", directPorts: "unoccupied",
    publicIngress: "unproven" };
}

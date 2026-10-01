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

// Before daemon-reload, verify no reserved unit or Direct port is live.
// The loaded-file binding is checked separately after the reload.
export async function inspectCleanSystemdInactivity({ showUnit = systemctlShow,
  inspectListeners = inspectCleanInstallListeners } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to inspect clean systemd inactivity");
  for (const [index, unit] of CLEAN_INSTALL_UNIT_NAMES.entries()) {
    const state = parse(await showUnit(unit));
    if (state.ActiveState !== "inactive" || state.DropInPaths !== "" ||
        (index >= 3 && (state.LoadState !== "not-found" || state.FragmentPath !== ""))) {
      throw new Error(`Clean-install reserved unit is active or overridden: ${unit}`);
    }
  }
  if ((await inspectListeners())?.directPorts !== "unoccupied") {
    throw new Error("Clean-install Direct service ports are occupied");
  }
  return { localSystemd: "inactive", directPorts: "unoccupied" };
}

// Check the manager's actual loaded view. Separate from signed disk and
// pointer checks so a disposable systemd host can exercise this boundary.
export async function inspectCleanLoadedSystemdUnits({ unitDirectory = "/etc/systemd/system",
  releaseRoot, identityPlan, showUnit = systemctlShow,
  inspectListeners = inspectCleanInstallListeners } = {}) {
  if (process.getuid?.() !== 0 || !path.isAbsolute(unitDirectory || "") ||
      path.normalize(unitDirectory) !== unitDirectory ||
      !path.isAbsolute(releaseRoot || "") || path.normalize(releaseRoot) !== releaseRoot ||
      !identityPlan) throw new Error("Root and normalized clean systemd bindings are required");
  const users = [identityPlan.workUser, identityPlan.agentUser, identityPlan.mcpUser];
  const groups = [identityPlan.ipcGroup, identityPlan.agentUser, identityPlan.mcpUser];
  for (const [index, unit] of CLEAN_INSTALL_UNIT_NAMES.entries()) {
    const state = parse(await showUnit(unit));
    if (state.ActiveState !== "inactive" || state.DropInPaths !== "") {
      throw new Error(`Clean-install systemd unit is active or overridden: ${unit}`);
    }
    if (index < 3) {
      if (state.LoadState !== "loaded" ||
          state.FragmentPath !== path.join(unitDirectory, unit) ||
          state.UnitFileState !== "disabled" ||
          state.WorkingDirectory !== path.join(releaseRoot, "current") ||
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
  return { localSystemd: "inactive-bound", directPorts: "unoccupied",
    publicIngress: "unproven" };
}

// Local boundary after daemon-reload and before starting the three core units.
// The public reverse-proxy route needs its own independent closed-ingress proof.
export async function inspectCleanSystemdBoundary({ journalPath, trustDir,
  unitDirectory = "/etc/systemd/system", showUnit = systemctlShow,
  inspectInstalled = inspectInstalledCleanUnits,
  inspectPointer = inspectPromotedCleanRelease,
  inspectListeners = inspectCleanInstallListeners,
  inspectLoaded = inspectCleanLoadedSystemdUnits } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to inspect clean systemd boundary");
  const journal = await readCleanInstallJournal(journalPath);
  if (!["pointer-ready", "systemd-intent", "systemd-ready"].includes(journal.phase)) {
    throw new Error("Clean pointer is not ready for systemd preflight");
  }
  if ((await inspectInstalled({ unitDirectory, workspace: journal.workspace,
    manifestSha256: journal.manifestSha256, trustDir }))?.units !== "bound-files" ||
      (await inspectPointer({ journal, trustDir,
        requireCurrent: true }))?.release !== "signed-inert") {
    throw new Error("Clean-install unit files or release pointer are unproven");
  }
  const report = await inspectLoaded({ unitDirectory, releaseRoot: journal.releaseRoot,
    identityPlan: journal.identityPlan, showUnit, inspectListeners });
  if ((await inspectPointer({ journal, trustDir,
    requireCurrent: true }))?.release !== "signed-inert") {
    throw new Error("Clean-install release changed during systemd preflight");
  }
  return report;
}

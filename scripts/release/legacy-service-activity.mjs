import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const LEGACY_UNITS = Object.freeze([
  "dp-beget-session-host.service", "dp-beget-agent.service", "dp-beget-mcp.service",
  "dp-beget-mcp-oauth-spike.service", "dp-beget-oauth-proxy.socket",
  "dp-beget-oauth-proxy.service", "dp-beget-tunnel.service"
]);
const REQUIRED_ACTIVE = new Set(LEGACY_UNITS.filter(unit => unit !== "dp-beget-oauth-proxy.service"));

async function systemctlShow(unit) {
  const { stdout } = await exec("systemctl", ["show", unit,
    "--property=LoadState,ActiveState", "--no-pager"], { timeout: 5000, maxBuffer: 4096 });
  return stdout;
}

export async function inspectLegacyServiceActivity({ showUnit = systemctlShow } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required for a migration service inventory");
  const activity = {};
  for (const unit of LEGACY_UNITS) {
    const fields = {};
    for (const line of (await showUnit(unit)).trim().split("\n")) {
      const at = line.indexOf("=");
      const key = line.slice(0, at);
      if (at < 1 || !["LoadState", "ActiveState"].includes(key) || Object.hasOwn(fields, key)) {
        throw new Error(`Invalid service state for ${unit}`);
      }
      fields[key] = line.slice(at + 1);
    }
    if (fields.LoadState !== "loaded" || !["active", "inactive"].includes(fields.ActiveState) ||
        (REQUIRED_ACTIVE.has(unit) && fields.ActiveState !== "active")) {
      throw new Error(`Unexpected legacy service state for ${unit}`);
    }
    activity[unit] = fields.ActiveState;
  }
  return activity;
}

export function validateLegacyServiceActivity(activity) {
  if (!activity || typeof activity !== "object" || Array.isArray(activity) ||
      Object.keys(activity).sort().join(",") !== [...LEGACY_UNITS].sort().join(",")) {
    throw new Error("Incomplete legacy service inventory");
  }
  for (const unit of LEGACY_UNITS) {
    if (!["active", "inactive"].includes(activity[unit]) ||
        (REQUIRED_ACTIVE.has(unit) && activity[unit] !== "active")) {
      throw new Error(`Invalid saved state for ${unit}`);
    }
  }
  return activity;
}

import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const UNIT = "dp-beget-tunnel.service";
const CONFIG = "/etc/dp-beget-tunnel/tunnel-client.yaml";
const TEMPLATE = fileURLToPath(new URL("../../deploy/tunnel/tunnel-client.yaml.template", import.meta.url));
const FIELDS = ["LoadState", "ActiveState", "MainPID", "User", "FragmentPath",
  "DropInPaths", "ExecStart", "EnvironmentFiles", "Environment"];

function check(ok) {
  if (!ok) throw new Error("Beget tunnel target could include an alternate OAuth ingress");
}

// Compare every YAML byte except the provisioned tunnel identifier. In
// particular, only the base MCP endpoint 127.0.0.1:8788 may receive this
// separate R0002 tunnel's requests. Neither config bytes nor IDs are logged.
export function validateBegetTunnelConfig(actual, template) {
  check(typeof actual === "string" && typeof template === "string" &&
    actual.length > 0 && actual.length < 4096 &&
    template.includes("  tunnel_id: __TUNNEL_ID__\n"));
  const matched = /^  tunnel_id: ([A-Za-z0-9_-]{1,128})$/m.exec(actual);
  check(matched && matched[1] !== "__TUNNEL_ID__" &&
    actual.replace(matched[0], "  tunnel_id: __TUNNEL_ID__") === template &&
    template.includes("      url: http://127.0.0.1:8788/mcp\n"));
  return true;
}

export function validateBegetTunnelUnit(output) {
  check(typeof output === "string");
  const values = {};
  for (const line of output.trimEnd().split("\n")) {
    const at = line.indexOf("=");
    check(at > 0 && FIELDS.includes(line.slice(0, at)) &&
      !Object.hasOwn(values, line.slice(0, at)));
    values[line.slice(0, at)] = line.slice(at + 1);
  }
  check(Object.keys(values).length === FIELDS.length &&
    values.LoadState === "loaded" &&
    ["active", "inactive"].includes(values.ActiveState) &&
    values.User === "dp-tunnel" && values.FragmentPath === `/etc/systemd/system/${UNIT}` &&
    ["", `/etc/systemd/system/${UNIT}.d/90-dp-r0004-migration-guard.conf`]
      .includes(values.DropInPaths) &&
    values.EnvironmentFiles === "" && values.Environment === "" &&
    /^\{ path=\/opt\/dp-beget-tunnel\/current\/tunnel-client ; argv\[\]=\/opt\/dp-beget-tunnel\/current\/tunnel-client run --config \/etc\/dp-beget-tunnel\/tunnel-client\.yaml ; ignore_errors=no ; start_time=\[[^\]\n]+\] ; stop_time=\[[^\]\n]+\] ; pid=\d+ ; code=(?:\(null\)|exited|killed) ; status=(?:0(?:\/0)?|15(?:\/TERM)?) \}$/.test(values.ExecStart) &&
    (values.ActiveState === "active" ? /^[1-9][0-9]*$/.test(values.MainPID) :
      values.MainPID === "0"));
  return { state: values.ActiveState, pid: values.MainPID };
}

export async function inspectBegetTunnelTarget() {
  check(process.getuid?.() === 0);
  const info = await lstat(CONFIG);
  check(info.isFile() && info.nlink === 1 && info.uid === 0 &&
    (info.mode & 0o7777) === 0o640 && info.size < 4096 &&
    await realpath(CONFIG) === CONFIG);
  const template = await readFile(TEMPLATE, "utf8");
  const show = async () => (await exec("systemctl", ["show", UNIT,
    `--property=${FIELDS.join(",")}`, "--no-pager"],
  { timeout: 5000, maxBuffer: 8192 })).stdout;
  const first = validateBegetTunnelUnit(await show());
  validateBegetTunnelConfig(await readFile(CONFIG, "utf8"), template);
  const last = validateBegetTunnelUnit(await show());
  check(JSON.stringify(first) === JSON.stringify(last));
  validateBegetTunnelConfig(await readFile(CONFIG, "utf8"), template);
  return { target: "127.0.0.1:8788/mcp", state: last.state, pid: last.pid };
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SOCKET = "dp-beget-oauth-proxy.socket";
const SERVICE = "dp-beget-oauth-proxy.service";
const DIRECTORY = "/etc/systemd/system";
const GUARD = "90-dp-r0004-migration-guard.conf";

function check(ok, reason) {
  if (!ok) throw new Error(`Beget OAuth proxy topology: ${reason}`);
}

function parse(output, fields) {
  check(typeof output === "string", "missing systemd properties");
  const result = {};
  for (const line of output.trimEnd().split("\n")) {
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    check(separator > 0 && fields.includes(key) && !Object.hasOwn(result, key),
      "unexpected systemd property");
    result[key] = line.slice(separator + 1);
  }
  check(Object.keys(result).length === fields.length, "incomplete systemd properties");
  return result;
}

const SOCKET_FIELDS = ["Listen", "Triggers", "LoadState", "ActiveState",
  "FragmentPath", "DropInPaths"];
const SERVICE_FIELDS = ["ExecStart", "User", "LoadState", "ActiveState",
  "FragmentPath", "DropInPaths"];

// Uses the systemd manager's loaded view; a guarded migration may have the
// sole known guard drop-in, and closed ingress may leave both units inactive.
export function validateBegetOAuthProxySnapshot(socketOutput, serviceOutput) {
  const socket = parse(socketOutput, SOCKET_FIELDS);
  const service = parse(serviceOutput, SERVICE_FIELDS);
  for (const [unit, value] of [[SOCKET, socket], [SERVICE, service]]) {
    const guard = `${DIRECTORY}/${unit}.d/${GUARD}`;
    check(value.LoadState === "loaded" &&
      ["active", "inactive"].includes(value.ActiveState) &&
      value.FragmentPath === `${DIRECTORY}/${unit}` &&
      ["", guard].includes(value.DropInPaths), `unexpected loaded ${unit}`);
  }
  check(socket.Listen === "172.18.0.1:8791 (Stream)" &&
    socket.Triggers === SERVICE, "socket listener or activated service changed");
  // An active command has code=(null) and status=0/0. After systemd stops a
  // service, its same ExecStart command can have code=exited and status=0.
  // These are execution metadata; the binary, arguments and target stay pinned.
  check(service.User === "dp-beget-oauth-proxy" &&
    /^\{ path=\/lib\/systemd\/systemd-socket-proxyd ; argv\[\]=\/lib\/systemd\/systemd-socket-proxyd 127\.0\.0\.1:8789 ; ignore_errors=no ; start_time=\[[^\]\n]+\] ; stop_time=\[[^\]\n]+\] ; pid=\d+ ; code=(?:\(null\)|exited|killed) ; status=(?:0(?:\/0)?|15(?:\/TERM)?) \}$/.test(service.ExecStart),
  "proxy command or target changed");
  check(socket.DropInPaths === service.DropInPaths.replace(`${SERVICE}.d`, `${SOCKET}.d`),
    "socket and service guards do not match");
  return { socketAddress: "172.18.0.1:8791", destination: "127.0.0.1:8789",
    socketState: socket.ActiveState, serviceState: service.ActiveState,
    guardInstalled: socket.DropInPaths !== "" };
}

export async function inspectBegetOAuthProxy() {
  check(process.getuid?.() === 0, "root is required");
  const show = async (unit, fields) => (await exec("systemctl", ["show", unit,
    "--no-pager", `--property=${fields.join(",")}`],
  { timeout: 5000, maxBuffer: 4096 })).stdout;
  const first = validateBegetOAuthProxySnapshot(
    await show(SOCKET, SOCKET_FIELDS), await show(SERVICE, SERVICE_FIELDS));
  const second = validateBegetOAuthProxySnapshot(
    await show(SOCKET, SOCKET_FIELDS), await show(SERVICE, SERVICE_FIELDS));
  check(JSON.stringify(first) === JSON.stringify(second),
    "proxy units changed during inspection");
  return first;
}

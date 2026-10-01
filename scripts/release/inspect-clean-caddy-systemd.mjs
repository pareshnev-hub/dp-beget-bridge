import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { inspectCleanCaddyProcess } from "./inspect-clean-caddy-process.mjs";

const exec = promisify(execFile);
const KEYS = ["Id", "LoadState", "ActiveState", "SubState", "MainPID", "ControlPID",
  "ControlGroup", "InvocationID", "User", "FragmentPath", "DropInPaths", "Transient", "NeedDaemonReload"];
function check(ok, reason) {
  if (!ok) throw new Error(`Caddy systemd binding: ${reason}`);
}

export function validateCleanCaddyUnitInputs(options) {
  const { unitName, unitFile, unitFileSha256, ownerUser, ownerUid, pid } = options;
  check(typeof unitName === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.service$/.test(unitName) &&
    unitName.length <= 128, "explicit service name required");
  check(typeof unitFile === "string" && path.isAbsolute(unitFile) && path.normalize(unitFile) === unitFile &&
    /^\/[a-zA-Z0-9_./-]+$/.test(unitFile) && path.basename(unitFile) === unitName,
  "normalized matching unit file required");
  check(/^[0-9a-f]{64}$/.test(unitFileSha256 || ""), "pinned unit SHA-256 required");
  check(typeof ownerUser === "string" && /^(?:[a-z_][a-z0-9_-]{0,31}|[1-9][0-9]*)$/.test(ownerUser) &&
    Number.isSafeInteger(ownerUid) && ownerUid > 0 && Number.isSafeInteger(pid) && pid > 1,
  "explicit non-root identity and process required");
}

// Parse only selected manager properties; never request Environment or
// ExecStart, which can include credentials or caller-supplied command text.
export function validateCleanCaddySystemdSnapshot(output, cgroup, options) {
  validateCleanCaddyUnitInputs(options);
  check(typeof output === "string" && output.length <= 16384, "manager inventory unavailable");
  const values = {};
  for (const line of output.trimEnd().split("\n")) {
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    check(separator > 0 && KEYS.includes(key) && !Object.hasOwn(values, key), "invalid manager inventory");
    values[key] = line.slice(separator + 1);
  }
  check(KEYS.every(key => Object.hasOwn(values, key)), "incomplete manager inventory");
  check(values.Id === options.unitName && values.LoadState === "loaded" &&
    values.ActiveState === "active" && values.SubState === "running" &&
    values.MainPID === String(options.pid) && values.ControlPID === "0" &&
    values.User === options.ownerUser && values.FragmentPath === options.unitFile &&
    values.DropInPaths === "" && values.Transient === "no" && values.NeedDaemonReload === "no",
  "service is inactive, overridden, stale or bound to another process");
  const controlGroup = `/system.slice/${options.unitName}`;
  check(values.ControlGroup === controlGroup && /^[0-9a-f]{32}$/.test(values.InvocationID) &&
    values.InvocationID !== "0".repeat(32), "service invocation is unidentified");
  check(typeof cgroup === "string" && cgroup.length <= 16384 && cgroup.trim() === `0::${controlGroup}`,
    "process is outside the expected unified service cgroup");
  return { unitName: options.unitName, unitFileSha256: options.unitFileSha256,
    invocationId: values.InvocationID, controlGroup, caddySystemd: "main-process-bound" };
}

async function boundedRead(filename, limit) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size <= limit) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) return buffer.subarray(0, size);
      size += bytesRead;
      check(size <= limit, "file exceeds inspection limit");
    }
  } finally { await file.close(); }
}

async function inspectUnitFile(filename, expectedSha) {
  check(await realpath(filename) === filename, "unit path contains a symlink");
  for (let parent = path.dirname(filename); ; parent = path.dirname(parent)) {
    const info = await lstat(parent);
    check(info.isDirectory() && info.uid === 0 && (info.mode & 0o022) === 0,
      "unit parent is not root-controlled");
    if (parent === "/") break;
  }
  const identity = info => ({ dev: info.dev, ino: info.ino, size: info.size,
    mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs });
  const before = await lstat(filename);
  check(before.isFile() && before.uid === 0 && before.nlink === 1 &&
    (before.mode & 0o022) === 0 && before.size > 0 && before.size <= 65536, "untrusted unit file");
  const sha = createHash("sha256").update(await boundedRead(filename, 65536)).digest("hex");
  const after = await lstat(filename);
  check(sha === expectedSha && isDeepStrictEqual(identity(before), identity(after)),
    "unit file does not match pinned bytes");
  return identity(before);
}

export async function inspectCleanCaddySystemd(options = {}) {
  validateCleanCaddyUnitInputs(options);
  check(process.platform === "linux" && process.getuid?.() === 0, "root Linux inspection required");
  try {
    const { unitName, unitFile, unitFileSha256, ownerUser, ownerUid, pid } = options;
    const show = async () => {
      const { stdout, stderr } = await exec("systemctl", ["show", unitName,
        `--property=${KEYS.join(",")}`, "--no-pager"], { timeout: 5000, maxBuffer: 16384 });
      check(!stderr.trim(), "manager inventory unavailable");
      return stdout;
    };
    const { stdout: uid, stderr } = await exec("id", ["-u", "--", ownerUser],
      { timeout: 5000, maxBuffer: 1024 });
    check(!stderr.trim() && uid.trim() === String(ownerUid), "service user resolves to another UID");
    const file = await inspectUnitFile(unitFile, unitFileSha256);
    const first = validateCleanCaddySystemdSnapshot(await show(),
      (await boundedRead(`/proc/${pid}/cgroup`, 16384)).toString("utf8"), options);
    const processProof = await inspectCleanCaddyProcess(options);
    const last = validateCleanCaddySystemdSnapshot(await show(),
      (await boundedRead(`/proc/${pid}/cgroup`, 16384)).toString("utf8"), options);
    check(isDeepStrictEqual(first, last) &&
      isDeepStrictEqual(file, await inspectUnitFile(unitFile, unitFileSha256)),
    "service or unit changed during inspection");
    return { ...processProof, ...first, unitFile: file, publicIngress: "unproven" };
  } catch (error) {
    if (error.message.startsWith("Caddy systemd binding:") || error.message.startsWith("Caddy process binding:")) throw error;
    throw new Error("Caddy systemd binding: live service evidence unavailable");
  }
}

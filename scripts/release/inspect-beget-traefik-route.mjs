import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const DIRECTORY = "/opt/beget/n8n/traefik_dynamic";
const FILE = "dp-beget-oauth.yml";
// Root read-only inventory, 2026-09-26. A change requires a fresh manual
// audit of the entire YAML file before updating this pinned fingerprint.
export const BEGET_OAUTH_ROUTE_SHA256 =
  "eeeec8b6c30fc69ca296957c55274aed9224dae804c1f3a57d826569bc8bd37b";
const FLAGS = new Set(["--providers.docker=true", "--providers.docker.exposedbydefault=false",
  "--providers.file.directory=/dynamic", "--providers.file.watch=true"]);
const OTHER_HOST_RULE = /^Host\(`(?:pareshnev\.com|www\.pareshnev\.com|mail\.pareshnev\.com|crarojofimo\.beget\.app)`\)(?: && (?:Path(?:Prefix)?\(`\/[-\w./]*`\)|\(Path\(`\/[-\w./]*`\) \|\| PathPrefix\(`\/[-\w./]*`\)\)))?$/;

function requireCondition(condition, message) {
  if (!condition) throw new Error(`Beget OAuth Traefik topology: ${message}`);
}
function sortedIds(output) {
  const ids = output.trim().split(/\s+/).filter(Boolean);
  requireCondition(ids.length > 0 && ids.every(id => /^[0-9a-f]{12,64}$/.test(id)) &&
    new Set(ids).size === ids.length, "invalid Docker container inventory");
  return ids.sort();
}
async function dockerJson(run, args) {
  const { stdout } = await run("docker", args, { timeout: 12000, maxBuffer: 4 * 1024 * 1024 });
  const value = JSON.parse(stdout);
  requireCondition(Array.isArray(value) && value.length > 0, "incomplete Docker inspection");
  return value;
}
async function fileDigest(directory) {
  const filename = path.join(directory, FILE);
  const info = await lstat(filename);
  requireCondition(info.isFile() && info.nlink === 1 && info.uid === 0 &&
    (info.mode & 0o022) === 0 && info.size > 0 && info.size <= 4096 &&
    (await realpath(filename)) === filename, "untrusted route file");
  const bytes = await readFile(filename);
  const sha = createHash("sha256").update(bytes).digest("hex");
  requireCondition(sha === BEGET_OAUTH_ROUTE_SHA256, "route file fingerprint changed");
  return sha;
}
function checkTraefik(container, directory) {
  requireCondition(container?.State?.Running === true && container.Name === "/n8n-traefik-1",
    "expected Traefik container not running");
  const flags = container.Args;
  requireCondition(Array.isArray(flags) && FLAGS.size ===
    flags.filter(flag => typeof flag === "string" && flag.startsWith("--providers.")).length &&
    [...FLAGS].every(flag => flags.includes(flag)) &&
    !flags.some(flag => /^--configfile(?:=|$)/i.test(flag)), "unexpected Traefik provider flags");
  requireCondition(!(container.Config?.Env || []).some(value => /^TRAEFIK_PROVIDERS_/i.test(value)),
    "provider environment override");
  const mounts = (container.Mounts || []).filter(mount => mount.Destination === "/dynamic");
  requireCondition(mounts.length === 1 && mounts[0].Type === "bind" && mounts[0].Source === directory,
    "unexpected dynamic configuration mount");
}
function checkContainers(containers) {
  let routers = 0;
  for (const container of containers) {
    requireCondition(container?.State?.Running === true &&
      container.HostConfig?.NetworkMode !== "host", "uninspected host-network container");
    const labels = container.Config?.Labels || {};
    const normalized = new Map();
    for (const [key, value] of Object.entries(labels)) {
      const lower = key.toLowerCase();
      requireCondition(!normalized.has(lower), "case-duplicate Docker label");
      normalized.set(lower, value);
    }
    const enabled = normalized.get("traefik.enable");
    requireCondition(enabled === undefined || enabled === "true" || enabled === "false",
      "unknown Docker provider enablement");
    if (enabled !== "true") continue;
    const configured = new Set();
    const ruled = new Set();
    for (const [key, value] of normalized) {
      requireCondition(!/^traefik\.(?:tcp|udp)\.routers\./.test(key),
        "uninspected TCP/UDP router");
      const router = /^traefik\.http\.routers\.([^.]+)\.([^.]+)$/.exec(key);
      if (!/^traefik\.http\.routers\./.test(key)) continue;
      requireCondition(router !== null, "invalid Docker router label");
      configured.add(router[1]);
      if (router[2] !== "rule") continue;
      requireCondition(OTHER_HOST_RULE.test(value), "Docker router can match the OAuth host");
      ruled.add(router[1]);
      routers++;
    }
    requireCondition(ruled.size > 0 && [...configured].every(name => ruled.has(name)),
      "enabled container may receive a default router rule");
  }
  return routers;
}

// Pure snapshot validator for isolated tests. The live inspector below supplies
// every snapshot input itself and pins the Docker mount to the Beget path.
export function validateBegetTraefikSnapshot(traefik, containers) {
  checkTraefik(traefik, DIRECTORY);
  return checkContainers(containers);
}

// Read-only proof of the observed Traefik file/Docker-provider topology.
// It is deliberately NOT an assertRouteExclusive callback: a separate live
// host listener/NAT/alternate-ingress proof is needed at the same boundary.
export async function inspectBegetTraefikOAuthRoute() {
  const directory = DIRECTORY;
  const run = exec;
  requireCondition(process.getuid?.() === 0, "root is required");
  const dir = await lstat(directory);
  requireCondition(dir.isDirectory() && dir.uid === 0 && (dir.mode & 0o022) === 0 &&
    (await realpath(directory)) === directory, "untrusted dynamic directory");
  const entries = await readdir(directory);
  requireCondition(entries.length === 1 && entries[0] === FILE, "dynamic directory inventory changed");
  const sha = await fileDigest(directory);
  const { stdout: initial } = await run("docker", ["ps", "--quiet"],
    { timeout: 12000, maxBuffer: 4096 });
  const ids = sortedIds(initial);
  const containers = await dockerJson(run, ["inspect", ...ids]);
  requireCondition(containers.length === ids.length &&
    containers.map(item => item.Id).sort().every((id, index) =>
      typeof id === "string" && id.startsWith(ids[index])),
  "Docker inventory changed during inspection");
  const traefik = containers.filter(item => item.Name === "/n8n-traefik-1");
  requireCondition(traefik.length === 1, "missing or duplicated Traefik container");
  const dockerRouters = validateBegetTraefikSnapshot(traefik[0], containers);
  const { stdout: final } = await run("docker", ["ps", "--quiet"],
    { timeout: 12000, maxBuffer: 4096 });
  requireCondition(JSON.stringify(sortedIds(final)) === JSON.stringify(ids),
    "Docker inventory changed during inspection");
  await fileDigest(directory);
  return { fileSha256: sha, dockerRouters, traefikContainerId: traefik[0].Id };
}

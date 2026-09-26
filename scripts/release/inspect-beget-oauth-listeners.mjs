import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const TRAEFIK = "/n8n-traefik-1";
const PUBLIC = new Set(["80", "443"]);
const PRIVATE = new Set(["8789", "8791"]);

function requireCondition(ok, message) {
  if (!ok) throw new Error(`Beget OAuth listener inventory: ${message}`);
}
function ids(stdout) {
  const result = stdout.trim().split(/\s+/).filter(Boolean).sort();
  requireCondition(result.length > 0 && result.every(id => /^[0-9a-f]{12,64}$/.test(id)) &&
    new Set(result).size === result.length, "invalid running Docker inventory");
  return result;
}

// Pure validation of the two independently observed surfaces. Only the
// dedicated bridge socket may bind 8791; OAuth's own 8789 is loopback-only.
// Public 80/443 must be published by the shared Traefik container alone.
export function validateBegetOAuthListenerSnapshot(ssOutput, containers) {
  requireCondition(typeof ssOutput === "string" && Array.isArray(containers) &&
    containers.length > 0, "missing host or Docker inventory");
  const seen = new Map();
  for (const raw of ssOutput.split("\n")) {
    if (!raw.trim() || raw.startsWith("State ")) continue;
    const columns = raw.trim().split(/\s+/);
    requireCondition(columns[0] === "LISTEN" && columns.length >= 5,
      "incomplete TCP listener response");
    const local = columns[3];
    const port = /:(\d+)$/.exec(local)?.[1];
    if (!PUBLIC.has(port) && !PRIVATE.has(port)) continue;
    const process = columns.slice(5).join(" ");
    if (port === "8789") {
      requireCondition(local === "127.0.0.1:8789", "OAuth process has another bind address");
    } else if (port === "8791") {
      requireCondition(local === "172.18.0.1:8791" && /systemd/.test(process),
        "dedicated socket has another bind address or owner");
    } else {
      requireCondition([`0.0.0.0:${port}`, `[::]:${port}`].includes(local) &&
        /docker-proxy/.test(process), "unexpected public HTTP listener");
    }
    requireCondition(!seen.has(local), "duplicate TCP listener");
    seen.set(local, port);
  }
  for (const port of PUBLIC) {
    requireCondition(seen.has(`0.0.0.0:${port}`) && seen.has(`[::]:${port}`),
      `missing expected Docker-proxy listener on ${port}`);
  }
  const traefik = containers.filter(c => c.Name === TRAEFIK);
  requireCondition(traefik.length === 1 && traefik[0].State?.Running === true,
    "missing running shared Traefik container");
  const published = new Set();
  for (const container of containers) {
    requireCondition(container.State?.Running === true &&
      container.HostConfig?.NetworkMode !== "host", "uninspected host-network container");
    const ports = container.NetworkSettings?.Ports;
    requireCondition(ports && typeof ports === "object", "missing Docker port bindings");
    for (const [containerPort, bindings] of Object.entries(ports)) {
      requireCondition(bindings === null || Array.isArray(bindings), "invalid Docker port binding");
      for (const binding of bindings || []) {
        const hostPort = binding?.HostPort;
        if (!PUBLIC.has(hostPort) && !PRIVATE.has(hostPort)) continue;
        requireCondition(container.Name === TRAEFIK && PUBLIC.has(hostPort) &&
          containerPort === `${hostPort}/tcp` &&
          ["0.0.0.0", "::"].includes(binding.HostIp),
        `unexpected Docker publisher for ${hostPort}`);
        const address = `${binding.HostIp}:${hostPort}`;
        requireCondition(!published.has(address), "duplicate Docker public binding");
        published.add(address);
      }
    }
  }
  for (const port of PUBLIC) {
    requireCondition(published.has(`0.0.0.0:${port}`) && published.has(`:::${port}`),
      `missing expected Traefik port publishing on ${port}`);
  }
  return { publicPorts: [80, 443], oauthAddress: "127.0.0.1:8789",
    proxyAddress: "172.18.0.1:8791", traefikContainerId: traefik[0].Id,
    listening: [...seen.keys()].sort() };
}

// This is a read-only component of a future exclusive-route proof, not a
// complete assertion: host NAT, other ingress and live Traefik routing remain
// separate checks. Neither proxy nor app socket must be active during recovery.
export async function inspectBegetOAuthListeners() {
  requireCondition(process.getuid?.() === 0, "root is required");
  const { stdout: before } = await exec("docker", ["ps", "--quiet"],
    { timeout: 12000, maxBuffer: 4096 });
  const expectedIds = ids(before);
  const { stdout: inspected } = await exec("docker", ["inspect", ...expectedIds],
    { timeout: 12000, maxBuffer: 4 * 1024 * 1024 });
  const containers = JSON.parse(inspected);
  requireCondition(Array.isArray(containers) && containers.length === expectedIds.length &&
    containers.map(c => c.Id).sort().every((id, index) =>
      typeof id === "string" && id.startsWith(expectedIds[index])),
  "Docker containers changed while inspecting ports");
  const { stdout: listeners } = await exec("ss", ["-ltnp"],
    { timeout: 12000, maxBuffer: 4 * 1024 * 1024 });
  const result = validateBegetOAuthListenerSnapshot(listeners, containers);
  const { stdout: after } = await exec("docker", ["ps", "--quiet"],
    { timeout: 12000, maxBuffer: 4096 });
  requireCondition(JSON.stringify(ids(after)) === JSON.stringify(expectedIds),
    "Docker containers changed while inspecting listeners");
  return result;
}

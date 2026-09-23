import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function waitForAdmissionDrain({ probes, timeoutMs = 15000, intervalMs = 100 }) {
  if (!Array.isArray(probes) || probes.length === 0 || probes.some(probe => typeof probe !== "function") ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error("Explicit health probes and bounded drain timing are required");
  }
  const deadline = Date.now() + timeoutMs;
  do {
    const controller = new AbortController();
    let timer;
    try {
      const reports = await Promise.race([
        Promise.all(probes.map(probe => probe({ signal: controller.signal }))),
        new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("Health probe timed out")); },
            Math.max(1, deadline - Date.now()));
        }),
      ]);
      if (reports.every(value => value?.status === "ok" && value.admission === "paused" &&
          value.inFlightRequests === 0)) return { drained: true, services: probes.length };
    } catch { /* A missing or timed-out service cannot be treated as drained. */ }
    finally { clearTimeout(timer); controller.abort(); }
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now()))));
  } while (Date.now() < deadline);
  throw new Error("Admission drain not proven before deadline");
}

function loopbackPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("A valid local service port is required");
  return port;
}

export function localReleaseHealthProbes({ agentPort = 8787, mcpPort = 8788,
  sessionSocket = "/run/dp-beget-bridge/session-host.sock", oauthPort } = {}) {
  if (!path.isAbsolute(sessionSocket)) throw new Error("An absolute Session Host socket path is required");
  const ports = [agentPort, mcpPort, ...(oauthPort === undefined ? [] : [oauthPort])].map(loopbackPort);
  if (new Set(ports).size !== ports.length) throw new Error("Bridge health ports must be distinct");
  const probes = ports.map(port => async ({ signal }) => {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal });
    if (!response.ok) throw new Error("Local bridge health is unavailable");
    return response.json();
  });
  probes.push(({ signal }) => new Promise((resolve, reject) => {
    const request = http.get({ socketPath: sessionSocket, path: "/health", signal }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error("Session Host health is unavailable")); return; }
      let bytes = 0;
      const chunks = [];
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 4096) { response.destroy(new Error("Session Host health response too large")); return; }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(error); }
      });
      response.on("error", reject);
    });
    request.on("error", reject);
  }));
  return probes;
}

async function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--agent-port", "--mcp-port", "--session-socket", "--oauth-port"].includes(args[i]) ||
        !args[i + 1] || Object.hasOwn(options, args[i])) {
      throw new Error("Usage: wait-admission-drain [--agent-port PORT] [--mcp-port PORT] [--session-socket ABSOLUTE_PATH] [--oauth-port PORT]");
    }
    options[args[i]] = args[i + 1];
  }
  const probes = localReleaseHealthProbes({ agentPort: options["--agent-port"] || 8787,
    mcpPort: options["--mcp-port"] || 8788,
    sessionSocket: options["--session-socket"] || "/run/dp-beget-bridge/session-host.sock",
    oauthPort: options["--oauth-port"] });
  const result = await waitForAdmissionDrain({ probes });
  console.log(`Admissions paused and ${result.services} local service queues drained`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Admission drain failed (${error.code || "validation"})`);
    process.exitCode = 1;
  });
}

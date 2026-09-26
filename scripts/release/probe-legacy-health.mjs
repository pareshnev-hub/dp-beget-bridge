import http from "node:http";
import path from "node:path";

function port(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error("Legacy health probe requires a valid loopback port");
  }
  return value;
}
function requestHealth(target) {
  return new Promise((resolve, reject) => {
    const request = http.get({ ...target, path: "/health", timeout: 5000 }, response => {
      if (response.statusCode !== 200 || response.headers.location) {
        response.resume(); reject(new Error("Legacy local health is unavailable")); return;
      }
      const chunks = [];
      let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 4096) {
          response.destroy(new Error("Legacy health response exceeded its limit")); return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) { reject(error); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("Legacy health probe timed out")));
    request.on("error", reject);
  });
}
export function validateLegacyHealth(body, product) {
  if (!body || typeof body !== "object" || body.status !== "ok" || body.product !== product ||
      Object.hasOwn(body, "admission") || Object.hasOwn(body, "inFlightRequests")) {
    throw new Error("Legacy health identity is not R0003");
  }
  return { status: body.status, product: body.product };
}

// Exact shape observed from the four running R0003 loopback endpoints on
// Beget. A 200 from the R0004 candidate is insufficient: it includes the
// admission fields that the legacy handlers do not emit.
export async function probeLegacyLocalHealth({ agentPort = 8787, mcpPort = 8788,
  oauthPort = 8789, sessionSocket = "/run/dp-beget-bridge/session-host.sock",
  request = requestHealth } = {}) {
  const ports = [agentPort, mcpPort, oauthPort].map(port);
  if (new Set(ports).size !== 3 || !path.isAbsolute(sessionSocket || "") ||
      path.normalize(sessionSocket) !== sessionSocket) {
    throw new Error("Legacy health endpoints must be distinct and local");
  }
  const targets = ports.map(value => ({ hostname: "127.0.0.1", port: value }));
  targets.push({ socketPath: sessionSocket });
  const expected = ["DP Beget Bridge", "DP Beget Bridge", "DP Beget Bridge",
    "DP Beget Bridge Session Host"];
  const results = await Promise.all(targets.map(async (target, index) =>
    validateLegacyHealth(await request(target), expected[index])));
  return { services: results.length, products: results.map(result => result.product) };
}

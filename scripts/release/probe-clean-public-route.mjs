import https from "node:https";
import { checkDnsAndTls, validateHostname, validatePublicIpv4 } from "./host-preflight.mjs";

function target(domain, expectedIp) {
  return { domain: validateHostname(domain), expectedIp: validatePublicIpv4(expectedIp) };
}

// Fixed HTTPS /mcp request: IP-pinned connection, hostname-validated TLS,
// no credentials or redirects, bounded headers/body and total elapsed time.
export function requestCleanPublicRoute({ domain, expectedIp, timeoutMs = 8000,
  httpsRequest = https.request } = {}) {
  ({ domain, expectedIp } = target(domain, expectedIp));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) {
    throw new Error("Invalid clean public route timeout");
  }
  return new Promise((resolve, reject) => {
    let request, response, timer;
    let finished = false;
    const fail = reason => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      response?.destroy();
      request?.destroy();
      reject(new Error(`Clean public route: ${reason}`));
    };
    timer = setTimeout(() => fail("deadline exceeded"), timeoutMs);
    try {
      request = httpsRequest({ protocol: "https:", hostname: expectedIp, family: 4,
        port: 443, servername: domain, rejectUnauthorized: true,
        method: "GET", path: "/mcp", agent: false, maxHeaderSize: 8192,
        headers: { Host: domain, Accept: "application/json", Connection: "close",
          "Cache-Control": "no-store" } }, incoming => {
        response = incoming;
        if (finished) { response.destroy(); return; }
        const chunks = [];
        let bytes = 0;
        response.on("error", () => fail("response failed"));
        response.on("aborted", () => fail("response incomplete"));
        response.on("data", chunk => {
          if (finished) return;
          bytes += chunk.length;
          if (bytes > 4096) { fail("body exceeds limit"); return; }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (finished) return;
          if (!response.complete) { fail("response incomplete"); return; }
          finished = true;
          clearTimeout(timer);
          resolve({ status: response.statusCode, headers: response.headers,
            body: Buffer.concat(chunks) });
        });
        response.on("close", () => {
          if (!finished) fail("response incomplete");
        });
      });
      request.on("error", () => fail("TLS or connection failed"));
      request.end();
    } catch { fail("request failed"); }
  });
}

// Supporting observation only. A 502 can come from the wrong upstream.
// Never return closed-exclusive or use this as inspectClosedIngress: loaded
// proxy configuration, alternate ingress and host topology need separate proof.
export async function probeCleanPublicRoute({ domain, expectedIp,
  inspectHost = checkDnsAndTls, request = requestCleanPublicRoute } = {}) {
  const binding = target(domain, expectedIp);
  const expected = { ...binding, dns: "pass", tls: "pass" };
  const checkHost = async () => {
    const report = await inspectHost(binding);
    if (!report || Object.entries(expected).some(([key, value]) => report[key] !== value)) {
      throw new Error("Clean public route host binding is unproven");
    }
  };
  await checkHost();
  const response = await request(binding);
  if (response?.status !== 502 || !response.headers ||
      response.headers["www-authenticate"] !== undefined ||
      response.headers["proxy-authenticate"] !== undefined ||
      response.headers.location !== undefined ||
      !Buffer.isBuffer(response.body) || response.body.length > 4096) {
    throw new Error("Clean public route did not return the expected closed-upstream response");
  }
  await checkHost();
  return { ...binding, path: "/mcp", status: 502,
    publicResponse: "closed-upstream", publicIngress: "unproven" };
}

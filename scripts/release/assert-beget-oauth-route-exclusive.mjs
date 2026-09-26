import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectBegetOAuthRouteBoundary } from "./inspect-beget-oauth-route-boundary.mjs";
import { inspectBegetOAuthProxy } from "./inspect-beget-oauth-proxy.mjs";
import { inspectBegetTunnelTarget } from "./inspect-beget-tunnel-target.mjs";
import { BEGET_OAUTH_ROUTE_SHA256 } from "./inspect-beget-traefik-route.mjs";
import { probeBegetClosedOAuthRoute } from "./probe-beget-closed-oauth-route.mjs";
import { probeBegetLegacyOAuthRoute, requestChallenge } from
  "./probe-beget-legacy-oauth-route.mjs";

const PUBLIC = Object.freeze({ label: "public", protocol: "https:",
  hostname: "45.12.238.143", port: 443,
  servername: "bridge-oauth.pareshnev.com", rejectUnauthorized: true });
const LEGACY_BODY_SHA256 = "49e5f417c2be040ca09371344a3d89a77277698a9a27c9c36fb268c2a2b91520";
const LEGACY_CHALLENGE = 'Bearer resource_metadata="https://bridge-oauth.pareshnev.com/.well-known/oauth-protected-resource", scope="terminal:read terminal:execute terminal:input terminal:close files:read files:write"';

function check(value) {
  if (!value) throw new Error("Beget exclusive OAuth route could not be established");
}

function paused(response) {
  check(response?.status === 503 && response.headers &&
    response.headers["content-type"]?.toLowerCase().startsWith("application/json") &&
    response.headers["cache-control"] === "no-store" &&
    response.headers.location === undefined &&
    response.headers["www-authenticate"] === undefined &&
    Buffer.isBuffer(response.body) && response.body.length > 0 &&
    response.body.length <= 4096);
  let body;
  try { body = JSON.parse(response.body.toString("utf8")); }
  catch { check(false); }
  check(body?.error?.code === "admission_paused");
}

// Root host-bound proof: the pinned DNS/TLS, Traefik provider/route, complete
// host listeners, Docker publishers, both NAT backends and loaded proxyd must
// agree with the current public response. Repeat the entire host inventory
// around the probe. This is a bounded snapshot, never a claim about external
// infrastructure or traffic that might arrive after the observation.
export async function assertBegetOAuthRouteExclusive({
  inspect = inspectBegetOAuthRouteBoundary,
  inspectProxy = inspectBegetOAuthProxy,
  inspectTunnel = inspectBegetTunnelTarget,
  publicRequest = requestChallenge,
  legacy = probeBegetLegacyOAuthRoute,
  closed = probeBegetClosedOAuthRoute
} = {}) {
  check(process.getuid?.() === 0);
  const first = await inspect();
  const proxyBefore = await inspectProxy();
  const tunnelBefore = await inspectTunnel();
  const response = await publicRequest(PUBLIC);
  const state = proxyBefore.socketState;
  check(["active", "inactive"].includes(state) &&
    proxyBefore.socketAddress === "172.18.0.1:8791" &&
    proxyBefore.destination === "127.0.0.1:8789");
  if (state === "inactive") {
    check(proxyBefore.serviceState === "inactive" && response?.status === 502 &&
      response.headers?.["www-authenticate"] === undefined &&
      response.headers?.location === undefined);
    check(await closed() === true);
  } else if (response?.status === 401) {
    check(response.headers?.["www-authenticate"] === LEGACY_CHALLENGE &&
      response.headers?.location === undefined &&
      response.headers?.["cache-control"] === "no-store" &&
      response.headers?.["content-type"] === "application/json; charset=utf-8");
    const parity = await legacy();
    check(parity?.status === 401 &&
      JSON.stringify(parity.hops) === JSON.stringify(["local", "socket", "public"]) &&
      parity.bodySha256 === LEGACY_BODY_SHA256 &&
      response.body && Buffer.isBuffer(response.body) &&
      createHash("sha256").update(response.body).digest("hex") === parity.bodySha256);
  } else {
    paused(response);
  }
  const proxyAfter = await inspectProxy();
  const tunnelAfter = await inspectTunnel();
  const last = await inspect();
  check(JSON.stringify(first) === JSON.stringify(last) &&
    first?.fileSha256 === BEGET_OAUTH_ROUTE_SHA256 &&
    first.publicIp === PUBLIC.hostname && first.natTarget === "172.18.0.2" &&
    first.proxyTarget === "127.0.0.1:8789" &&
    first.scope === "DNS, TLS, Traefik, host listeners, Docker NAT and loaded proxy units only" &&
    first.dockerRouters === 10 &&
    /^[0-9a-f]{64}$/.test(first.traefikContainerId || "") &&
    JSON.stringify([...(first.externalTcp || [])].sort()) === JSON.stringify([
      "0.0.0.0:22", "0.0.0.0:443", "0.0.0.0:80",
      "[::]:22", "[::]:443", "[::]:80"].sort()) &&
    proxyAfter.socketState === state &&
    (state === "inactive" || proxyAfter.serviceState === "active") &&
    proxyAfter.socketAddress === proxyBefore.socketAddress &&
    proxyAfter.destination === proxyBefore.destination &&
    proxyAfter.guardInstalled === proxyBefore.guardInstalled &&
    tunnelBefore.target === "127.0.0.1:8788/mcp" &&
    tunnelAfter.target === tunnelBefore.target &&
    tunnelBefore.state === state &&
    JSON.stringify(tunnelAfter) === JSON.stringify(tunnelBefore) &&
    (state !== "inactive" || proxyAfter.serviceState === "inactive"));
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertBegetOAuthRouteExclusive().then(() => {
    console.log(JSON.stringify({ exclusive: true,
      scope: "pinned Beget host, tunnel, Traefik and current public response only" }));
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

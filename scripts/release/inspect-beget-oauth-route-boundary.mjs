import { inspectBegetTraefikOAuthRoute, BEGET_OAUTH_ROUTE_SHA256 } from
  "./inspect-beget-traefik-route.mjs";
import { inspectBegetOAuthListeners } from "./inspect-beget-oauth-listeners.mjs";
import { inspectBegetOAuthNat } from "./inspect-beget-oauth-nat.mjs";
import { checkDnsAndTls } from "./host-preflight.mjs";

const OAUTH_DOMAIN = "bridge-oauth.pareshnev.com";
const PUBLIC_IP = "45.12.238.143";

// Compare separate provider and host observations. The second pair detects
// common changes while gathering the first; this cannot make host state atomic.
export function compareBegetOAuthRouteSnapshots(first, second) {
  const [routeA, hostA, publicA, natA] = first || [];
  const [routeB, hostB, publicB, natB] = second || [];
  const id = routeA?.traefikContainerId;
  if (!/^[0-9a-f]{64}$/.test(id || "") ||
      [hostA?.traefikContainerId, routeB?.traefikContainerId,
        hostB?.traefikContainerId, natA?.traefikContainerId,
        natB?.traefikContainerId].some(value => value !== id) ||
      routeA.fileSha256 !== BEGET_OAUTH_ROUTE_SHA256 ||
      routeB.fileSha256 !== routeA.fileSha256 ||
      !Number.isSafeInteger(routeA.dockerRouters) || routeA.dockerRouters < 0 ||
      routeB.dockerRouters !== routeA.dockerRouters ||
      !Array.isArray(hostA?.listening) || !Array.isArray(hostB?.listening) ||
      JSON.stringify(hostB.listening) !== JSON.stringify(hostA.listening) ||
      JSON.stringify(hostB.publicPorts) !== JSON.stringify([80, 443]) ||
      JSON.stringify(hostA.publicPorts) !== JSON.stringify([80, 443]) ||
      [natA, natB].some(value => value?.ipv4Target !== "172.18.0.2" ||
        JSON.stringify(value.ipv4PublicPorts) !== JSON.stringify([80, 443]) ||
        value.ipv6Dnat !== false || !Array.isArray(value.loopbackTargets) ||
        value.loopbackTargets.length !== 2) ||
      JSON.stringify(natA?.loopbackTargets) !== JSON.stringify(natB?.loopbackTargets) ||
      [publicA, publicB].some(value => value?.domain !== OAUTH_DOMAIN ||
        value.expectedIp !== PUBLIC_IP || value.dns !== "pass" || value.tls !== "pass")) {
    throw new Error("Beget OAuth route surfaces changed or belong to different containers");
  }
  return { traefikContainerId: id, fileSha256: routeA.fileSha256,
    dockerRouters: routeA.dockerRouters, listening: [...hostA.listening],
    publicIp: PUBLIC_IP, natTarget: natA.ipv4Target,
    scope: "DNS, TLS, Traefik providers, host listeners and pinned Docker NAT only" };
}

// Root-only read-only inventory; intentionally no assertRouteExclusive result.
// A caller must separately prove all alternative public ingress
// before using a true exclusive-route callback in the migration transaction.
export async function inspectBegetOAuthRouteBoundary() {
  const first = [await inspectBegetTraefikOAuthRoute(), await inspectBegetOAuthListeners(),
    await checkDnsAndTls({ domain: OAUTH_DOMAIN, expectedIp: PUBLIC_IP }),
    await inspectBegetOAuthNat()];
  const second = [await inspectBegetTraefikOAuthRoute(), await inspectBegetOAuthListeners(),
    await checkDnsAndTls({ domain: OAUTH_DOMAIN, expectedIp: PUBLIC_IP }),
    await inspectBegetOAuthNat()];
  return compareBegetOAuthRouteSnapshots(first, second);
}

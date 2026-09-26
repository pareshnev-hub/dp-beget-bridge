import { requestChallenge } from "./probe-beget-legacy-oauth-route.mjs";

const PUBLIC = Object.freeze({ label: "public", protocol: "https:",
  hostname: "45.12.238.143", port: 443,
  servername: "bridge-oauth.pareshnev.com", rejectUnauthorized: true });

// Run only after the dedicated R0003 socket and tunnel have been stopped.
// An unexpected public OAuth challenge or redirect retains the durable
// marker. A 502 is supporting evidence, not independent route exclusivity.
export async function probeBegetClosedOAuthRoute({ request = requestChallenge } = {}) {
  const response = await request(PUBLIC);
  if (response?.status !== 502 || !response.headers ||
      response.headers["www-authenticate"] !== undefined ||
      response.headers.location !== undefined ||
      !Buffer.isBuffer(response.body) || response.body.length > 4096) {
    throw new Error("Public OAuth route did not close behind the dedicated socket");
  }
  return true;
}

const PUBLIC_URL = "https://bridge-oauth.pareshnev.com/mcp";
const METADATA_URL = "https://bridge-oauth.pareshnev.com/.well-known/oauth-protected-resource";

// A public challenge is meaningful only alongside the independent exclusive
// route proof and the local original-unit and R0003 health checks.
export async function probePublicLegacyOAuth({ request = fetch } = {}) {
  const response = await request(PUBLIC_URL, {
    method: "GET", redirect: "error", cache: "no-store", credentials: "omit",
    headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000)
  });
  const challenge = response.headers.get("www-authenticate");
  if (response.url !== PUBLIC_URL || response.status !== 401 ||
      !response.headers.get("content-type")?.toLowerCase().startsWith("application/json") ||
      response.headers.get("cache-control")?.toLowerCase() !== "no-store" ||
      !challenge?.startsWith(`Bearer resource_metadata="${METADATA_URL}", scope="`) ||
      !challenge.endsWith('"') || !response.body) {
    await response.body?.cancel();
    throw new Error("Public R0003 OAuth challenge not proven");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) throw new Error("Public OAuth challenge body exceeds limit");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Public OAuth challenge is invalid JSON"); }
  if (data?.error?.code !== "unauthorized") {
    throw new Error("Public OAuth response did not come from the legacy authorization gate");
  }
  return true;
}

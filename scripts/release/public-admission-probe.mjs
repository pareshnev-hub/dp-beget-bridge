const PUBLIC_URL = "https://bridge-oauth.pareshnev.com/mcp";

// This probe is deliberately fixed to the known public OAuth hostname. The
// independent route proof must still establish that it targets the dedicated
// proxy socket exclusively; a correct 503 alone cannot prove the route.
export async function probePublicOAuthPaused({ request = fetch } = {}) {
  const response = await request(PUBLIC_URL, {
    method: "GET", redirect: "error", cache: "no-store", credentials: "omit",
    headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000)
  });
  if (response.url !== PUBLIC_URL || response.status !== 503 ||
      !response.headers.get("content-type")?.toLowerCase().startsWith("application/json") ||
      response.headers.get("cache-control")?.toLowerCase() !== "no-store" || !response.body) {
    await response.body?.cancel();
    throw new Error("Public OAuth admission denial not proven");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4096) throw new Error("Public OAuth denial body exceeds limit");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Public OAuth admission denial is invalid JSON"); }
  if (data?.error?.code !== "admission_paused") {
    throw new Error("Public OAuth response did not come from the admission gate");
  }
  return true;
}

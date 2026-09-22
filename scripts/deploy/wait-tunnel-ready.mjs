import { pathToFileURL } from "node:url";

export async function waitForTunnelReady({
  url = "http://127.0.0.1:8790/readyz",
  timeoutMs = 15000,
  intervalMs = 100,
  fetchImpl = fetch,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unavailable";
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(Math.min(1000, timeoutMs)) });
      lastStatus = `HTTP ${response.status}`;
      if (response.ok) return;
    } catch {
      lastStatus = "unavailable";
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Tunnel readiness did not pass within ${timeoutMs} ms (${lastStatus})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const timeoutMs = Number(process.argv[2] || 15000);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Timeout must be a positive number");
  await waitForTunnelReady({ timeoutMs });
  console.log("Tunnel readiness check passed.");
}

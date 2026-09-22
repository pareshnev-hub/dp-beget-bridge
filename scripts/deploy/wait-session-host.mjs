import http from "node:http";

const socketPath = process.argv[2] || "/run/dp-beget-bridge/session-host.sock";
const timeoutMs = Number.parseInt(process.argv[3] || "15000", 10);
const deadline = Date.now() + timeoutMs;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probe() {
  await new Promise((resolve, reject) => {
    const request = http.get({ socketPath, path: "/health" }, (response) => {
      response.resume();
      response.on("end", () => response.statusCode === 200
        ? resolve()
        : reject(new Error(`HTTP ${response.statusCode}`)));
    });
    request.on("error", reject);
  });
}

let lastError;
while (Date.now() < deadline) {
  try {
    await probe();
    console.log("Session Host readiness check passed.");
    process.exit(0);
  } catch (error) {
    lastError = error;
    await delay(100);
  }
}

console.error(`Session Host readiness check failed: ${lastError?.code || lastError?.message || "timeout"}.`);
process.exit(1);

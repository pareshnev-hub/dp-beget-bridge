// Disposable CI client only. The parent starts a separate Node process with
// NODE_EXTRA_CA_CERTS pointing to a purpose-built ephemeral fixture CA.
// DNS is explicitly simulated; TLS and the production HTTPS/config readers
// are real. This must never be substituted for a public acceptance record.
import { inspectCleanCaddyHostRoute } from "../release/inspect-clean-caddy-host.mjs";
import { inspectCleanCaddyRoute } from "../release/inspect-clean-caddy-config.mjs";
import { probeCleanPublicRoute, requestCleanPublicRoute } from "../release/probe-clean-public-route.mjs";
import { checkDnsAndTls } from "../release/host-preflight.mjs";

if (process.env.DP_TEST_REAL_CADDY_PROCESS !== "1" || process.platform !== "linux" ||
    process.getuid?.() !== 0 || process.argv.length !== 4 || process.argv[2] !== "--fixture-options") {
  throw new Error("Explicit disposable root HTTPS fixture required");
}
const options = JSON.parse(process.argv[3]);
if (options.domain !== "bridge.example.invalid" || options.expectedIp !== "1.1.1.1") {
  throw new Error("Unexpected isolated HTTPS fixture target");
}
try {
  if (options.scenario === "wrong-hostname") {
    await requestCleanPublicRoute({ domain: "wrong.example.invalid", expectedIp: options.expectedIp });
    console.log("Unexpected wrong-hostname TLS acceptance");
    process.exitCode = 2;
  } else {
  const report = await inspectCleanCaddyHostRoute({ ...options,
    inspectRoute: routeOptions => inspectCleanCaddyRoute({ ...routeOptions,
      probePublic: binding => probeCleanPublicRoute({ ...binding,
        inspectHost: target => checkDnsAndTls({ ...target,
          resolve4: async () => [options.expectedIp], resolve6: async () => [] }) }) }) });
  console.log(JSON.stringify({ caddySystemd: report.caddySystemd, caddyProcess: report.caddyProcess,
    hostIngress: report.hostIngress, caddyConfig: report.caddyConfig,
    publicResponse: report.publicResponse, publicIngress: report.publicIngress,
    tls: "real-fixture-ca", dns: "simulated" }));
  }
} catch {
  console.error("Disposable Caddy HTTPS fixture rejected");
  process.exitCode = 1;
}

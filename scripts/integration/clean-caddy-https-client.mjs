// Disposable CI client only. The parent starts a separate Node process with
// NODE_EXTRA_CA_CERTS pointing to a purpose-built ephemeral fixture CA.
// DNS is explicitly simulated; TLS and the production HTTPS/config readers
// are real. This must never be substituted for a public acceptance record.
import { inspectCleanCaddyHost, inspectCleanCaddyHostRoute } from "../release/inspect-clean-caddy-host.mjs";
import { inspectCleanCaddySystemd } from "../release/inspect-clean-caddy-systemd.mjs";
import { inspectClosedCleanCaddyConfig, inspectCleanCaddyRoute } from "../release/inspect-clean-caddy-config.mjs";
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
let stage = "input";
try {
  if (options.scenario === "wrong-hostname") {
    await requestCleanPublicRoute({ domain: "wrong.example.invalid", expectedIp: options.expectedIp });
    console.log("Unexpected wrong-hostname TLS acceptance");
    process.exitCode = 2;
  } else {
  const report = await inspectCleanCaddyHostRoute({ ...options,
    inspectSystemd: input => { stage = "systemd"; return inspectCleanCaddySystemd(input); },
    inspectHost: input => { stage = "host"; return inspectCleanCaddyHost(input); },
    inspectRoute: routeOptions => inspectCleanCaddyRoute({ ...routeOptions,
      inspectConfig: input => { stage = "config"; return inspectClosedCleanCaddyConfig(input); },
      probePublic: binding => probeCleanPublicRoute({ ...binding,
        request: input => { stage = "https-response"; return requestCleanPublicRoute(input); },
        inspectHost: target => { stage = "tls"; return checkDnsAndTls({ ...target,
          resolve4: async () => [options.expectedIp], resolve6: async () => [] }); } }) }) });
  console.log(JSON.stringify({ caddySystemd: report.caddySystemd, caddyProcess: report.caddyProcess,
    hostIngress: report.hostIngress, caddyConfig: report.caddyConfig,
    localAddress: report.localAddress, localRoute: report.localRoute, policyRules: report.policyRules,
    publicResponse: report.publicResponse, publicIngress: report.publicIngress,
    tls: "real-fixture-ca", dns: "simulated" }));
  }
} catch (error) {
  // These modules emit fixed bounded diagnostic reasons, never raw config,
  // certificate bytes, credential values or remote response bodies.
  const reason = /^(?:Caddy |Clean Caddy |Clean public |Closed Caddy |HTTPS certificate)/.test(error.message || "")
    ? error.message.slice(0,160) : "evidence unavailable";
  console.error(`Disposable Caddy HTTPS fixture rejected at ${stage}: ${reason}`);
  process.exitCode = 1;
}

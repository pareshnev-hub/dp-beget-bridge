// Disposable joined fixture: actual protected/signed installation and actual
// Caddy/systemd/host/TLS readers. Only DNS is simulated; the private test CA
// is loaded through NODE_EXTRA_CA_CERTS in this separate Node process.
import { inspectCleanInstallRoute } from "../release/inspect-clean-install-route.mjs";
import { readCleanPrivateRequest } from "../release/install-clean-private.mjs";
import { inspectCleanCaddyHostRoute } from "../release/inspect-clean-caddy-host.mjs";
import { inspectCleanCaddyRoute } from "../release/inspect-clean-caddy-config.mjs";
import { probeCleanPublicRoute } from "../release/probe-clean-public-route.mjs";
import { checkDnsAndTls } from "../release/host-preflight.mjs";
import assert from "node:assert/strict";
import { inspectCleanClosedIngress } from "../release/inspect-clean-closed-ingress.mjs";

if (process.env.DP_TEST_REAL_CADDY_PROCESS !== "1" || process.env.DP_TEST_REAL_PRIVATE_INSTALL !== "1" ||
    process.platform !== "linux" || process.getuid?.() !== 0 || process.argv.length !== 4 ||
    process.argv[2] !== "--fixture-install-options") throw new Error("Explicit joined disposable root HTTPS fixture required");
try {
  const inputs = JSON.parse(process.argv[3]);
  if (Object.keys(inputs).sort().join() !== "journalPath,policyPath,requestPath,trustDir") throw new Error("Invalid joined fixture inputs");
  const request = await readCleanPrivateRequest(inputs.requestPath);
  if (request.domain !== "bridge.example.invalid" || request.expectedIp !== "1.1.1.1" ||
      !/^\/var\/lib\/dp-ci-release-[a-f0-9]{10}$/.test(request.releaseRoot) ||
      !/^\/srv\/dp-ci-work-[a-f0-9]{10}$/.test(request.allowedRoot)) throw new Error("Invalid disposable install binding");
  const report = await inspectCleanInstallRoute({ ...inputs,
    inspectRoute: options => inspectCleanCaddyHostRoute({ ...options,
      inspectRoute: route => inspectCleanCaddyRoute({ ...route,
        probePublic: binding => probeCleanPublicRoute({ ...binding,
          inspectHost: target => checkDnsAndTls({ ...target,
            resolve4: async () => [request.expectedIp], resolve6: async () => [] }) }) }) }) });
  // This real isolated proxy must never authorize PID 1's application units.
  // The production gate rejects before any DNS simulation or state mutation.
  await assert.rejects(inspectCleanClosedIngress(inputs), /initial host network namespace required/);
  console.log(JSON.stringify({ commit: report.commit, artifactSha256: report.artifactSha256,
    policySha256: report.policySha256, installRoute: report.installRoute, publicIngress: report.publicIngress,
    dns: "simulated", tls: "real-fixture-ca", proxy: "actual-Caddy-systemd-host",
    hostStartupGate: "rejected-isolated-namespace" }));
} catch (error) {
  const reason = /^(?:Clean installation route:|Caddy |Clean Caddy |Clean public |Closed Caddy |HTTPS certificate)/.test(error.message || "")
    ? error.message.slice(0, 160) : "joined evidence unavailable";
  console.error(`Disposable joined installation HTTPS fixture rejected: ${reason}`);
  process.exitCode = 1;
}

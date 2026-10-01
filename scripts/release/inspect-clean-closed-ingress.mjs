import { readFile, readlink } from "node:fs/promises";
import { inspectCleanInstallRoute } from "./inspect-clean-install-route.mjs";
import { inspectCleanCaddyHostRoute } from "./inspect-clean-caddy-host.mjs";
import { assertSupportedOs } from "./host-preflight.mjs";

function check(ok, reason) { if (!ok) throw new Error(`Clean closed ingress: ${reason}`); }

// Explicit dedicated-host startup gate. A protected original request and
// proxy policy bind the signed installation to the real DNS/CA/Caddy chain.
// The inspector, PID 1 and Caddy must share the initial host namespace: an
// isolated fixture/container cannot authorize systemd's host-wide services.
export async function inspectCleanClosedIngress({ requestPath, journalPath, policyPath, trustDir,
  inspectInstall = inspectCleanInstallRoute, inspectRoute = inspectCleanCaddyHostRoute,
  readNamespace = readlink, isRoot = () => process.getuid?.() === 0,
  isLinux = () => process.platform === "linux", readOs = () => readFile("/etc/os-release", "utf8") } = {}) {
  check(isRoot() && isLinux(), "root Linux inspection required");
  assertSupportedOs(await readOs());
  const namespaces = async () => {
    const self = await readNamespace("/proc/self/ns/net"), initial = await readNamespace("/proc/1/ns/net");
    check(/^net:\[[1-9][0-9]*\]$/.test(self || "") && self === initial,
      "initial host network namespace required");
    return self;
  };
  const initial = await namespaces();
  let observed = false;
  const report = await inspectInstall({ requestPath, journalPath, policyPath, trustDir,
    inspectRoute: async options => {
      const route = await inspectRoute(options);
      check(route?.netNamespace === initial, "proxy differs from the initial host namespace");
      observed = true;
      return route;
    } });
  check(observed && report?.installRoute === "signed-install-bound" && report.publicIngress === "unproven" &&
    /^[0-9a-f-]{36}$/.test(report.transactionId || "") && /^[0-9a-f]{40}$/.test(report.commit || "") &&
    ["manifestSha256", "artifactSha256", "policySha256"].every(key => /^[0-9a-f]{64}$/.test(report[key] || "")),
    "complete protected installation/route evidence required");
  check(await namespaces() === initial, "initial host namespace changed around inspection");
  return { ...report, publicIngress: "closed-exclusive", netNamespace: initial,
    closure: "static-Caddy-profile", scope: "dedicated initial host namespace; pinned static closed Caddy and signed installation; no application exposure" };
}

#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectBegetOAuthRouteBoundary } from "./inspect-beget-oauth-route-boundary.mjs";
import { inspectBegetLegacyDataBindings } from "./inspect-beget-legacy-data-bindings.mjs";
import { probeBegetLegacyOAuthRoute } from "./probe-beget-legacy-oauth-route.mjs";

// Read-only preflight for the currently active R0003 route. Reinspect the
// host after the public request, so a changed route cannot be reported as
// one stable observation. This is evidence, never assertRouteExclusive.
export async function preflightBegetLegacyRoute({
  inspect = inspectBegetOAuthRouteBoundary,
  inspectBindings = inspectBegetLegacyDataBindings,
  probe = probeBegetLegacyOAuthRoute
} = {}) {
  const bindingsBefore = await inspectBindings();
  const before = await inspect();
  const parity = await probe();
  const after = await inspect();
  const bindingsAfter = await inspectBindings();
  if (JSON.stringify(before) !== JSON.stringify(after) ||
      JSON.stringify(bindingsBefore) !== JSON.stringify(bindingsAfter)) {
    throw new Error("Beget legacy route or data bindings changed during the read-only preflight");
  }
  return { boundary: after, parity, bindings: bindingsAfter,
    scope: "active R0003 route, challenge parity and three live database bindings; no drain or exclusive ingress proof" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error("Usage: node scripts/release/preflight-beget-legacy-route.mjs");
    process.exitCode = 1;
  } else {
    preflightBegetLegacyRoute().then(report => {
      console.log(JSON.stringify(report));
    }).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}

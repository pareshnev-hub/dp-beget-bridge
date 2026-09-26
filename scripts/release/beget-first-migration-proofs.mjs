import path from "node:path";
import { assertBegetOAuthRouteExclusive } from "./assert-beget-oauth-route-exclusive.mjs";
import { assertInstrumentedLegacyDrain } from "./assert-instrumented-legacy-drain.mjs";
import { PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";

// The same live route proof is used before closure, while ingress is closed
// and during candidate release. The drain runs only at ingress-closed and
// verifies the journal, marker, four writers and two zero-counter snapshots.
// The migration controller still supplies the exact paths and retains its
// journal phase checks; this is not a standalone VPS migration command.
export function begetFirstMigrationProofs({ journalPath, marker = PERSISTENT_MARKER,
  route = assertBegetOAuthRouteExclusive,
  drain = assertInstrumentedLegacyDrain } = {}) {
  if (process.getuid?.() !== 0 ||
      [journalPath, marker].some(value => typeof value !== "string" ||
        !path.isAbsolute(value) || path.normalize(value) !== value) ||
      typeof route !== "function" || typeof drain !== "function") {
    throw new Error("Exact root-owned migration paths and Beget proof functions are required");
  }
  const assertRouteExclusive = async () => await route();
  const assertNoInFlight = async () => await drain({ journalPath, marker,
    assertRouteExclusive });
  return { journalPath, marker, assertRouteExclusive, assertNoInFlight };
}

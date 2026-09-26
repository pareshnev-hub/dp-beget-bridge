import test from "node:test";
import assert from "node:assert/strict";
import { preflightBegetLegacyRoute } from
  "../scripts/release/preflight-beget-legacy-route.mjs";

test("OPS-07: root inventory brackets live challenge parity without granting exclusivity", async () => {
  const calls = [];
  const boundary = { traefikContainerId: "a".repeat(64), listening: ["0.0.0.0:443"] };
  const report = await preflightBegetLegacyRoute({
    inspect: async () => { calls.push("inspect"); return { ...boundary }; },
    probe: async () => { calls.push("probe"); return { status: 401 }; }
  });
  assert.deepEqual(calls, ["inspect", "probe", "inspect"]);
  assert.deepEqual(report.boundary, boundary);
  assert.deepEqual(report.parity, { status: 401 });
  assert.match(report.scope, /no exclusive ingress proof/);
  assert.equal(report.assertRouteExclusive, undefined);
});

test("OPS-07: a route change across the public challenge fails closed", async () => {
  let iteration = 0;
  await assert.rejects(preflightBegetLegacyRoute({
    inspect: async () => ({ traefikContainerId: String(++iteration) }),
    probe: async () => ({ status: 401 })
  }), /changed during/);
});

test("OPS-07: failed public challenge cannot produce a preflight report", async () => {
  let inspections = 0;
  await assert.rejects(preflightBegetLegacyRoute({
    inspect: async () => { inspections++; return {}; },
    probe: async () => { throw new Error("challenge failed"); }
  }), /challenge failed/);
  assert.equal(inspections, 1);
});

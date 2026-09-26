import test from "node:test";
import assert from "node:assert/strict";
import { preflightBegetLegacyRoute } from
  "../scripts/release/preflight-beget-legacy-route.mjs";

test("OPS-07: root inventory brackets live challenge parity without granting exclusivity", async () => {
  const calls = [];
  const boundary = { traefikContainerId: "a".repeat(64), listening: ["0.0.0.0:443"] };
  const bindings = { databases: [{ unit: "oauth", size: 64 }] };
  const report = await preflightBegetLegacyRoute({
    inspectBindings: async () => { calls.push("bindings"); return { ...bindings }; },
    inspect: async () => { calls.push("inspect"); return { ...boundary }; },
    probe: async () => { calls.push("probe"); return { status: 401 }; }
  });
  assert.deepEqual(calls, ["bindings", "inspect", "probe", "inspect", "bindings"]);
  assert.deepEqual(report.boundary, boundary);
  assert.deepEqual(report.bindings, bindings);
  assert.deepEqual(report.parity, { status: 401 });
  assert.match(report.scope, /no drain or exclusive ingress proof/);
  assert.equal(report.assertRouteExclusive, undefined);
});

test("OPS-07: a route change across the public challenge fails closed", async () => {
  let iteration = 0;
  await assert.rejects(preflightBegetLegacyRoute({
    inspectBindings: async () => ({}),
    inspect: async () => ({ traefikContainerId: String(++iteration) }),
    probe: async () => ({ status: 401 })
  }), /changed during/);
});

test("OPS-07: failed public challenge cannot produce a preflight report", async () => {
  let inspections = 0;
  await assert.rejects(preflightBegetLegacyRoute({
    inspectBindings: async () => ({}),
    inspect: async () => { inspections++; return {}; },
    probe: async () => { throw new Error("challenge failed"); }
  }), /challenge failed/);
  assert.equal(inspections, 1);
});

test("OPS-07: a data binding change across the public challenge fails closed", async () => {
  let iteration = 0;
  await assert.rejects(preflightBegetLegacyRoute({
    inspectBindings: async () => ({ databases: [{ size: ++iteration }] }),
    inspect: async () => ({ traefikContainerId: "a".repeat(64) }),
    probe: async () => ({ status: 401 })
  }), /changed during/);
});

test("OPS-07: failed binding inventory cannot produce a preflight report", async () => {
  let routeInspections = 0;
  await assert.rejects(preflightBegetLegacyRoute({
    inspectBindings: async () => { throw new Error("sqlite-inventory"); },
    inspect: async () => { routeInspections++; return {}; },
    probe: async () => ({ status: 401 })
  }), /sqlite-inventory/);
  assert.equal(routeInspections, 0);
});

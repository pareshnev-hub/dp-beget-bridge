import test from "node:test";
import assert from "node:assert/strict";
import { inspectLegacyServiceActivity, LEGACY_UNITS } from "../scripts/release/legacy-service-activity.mjs";

test("first migration records an active ingress set and an optionally idle socket proxy", {
  skip: process.getuid?.() !== 0
}, async () => {
  const result = await inspectLegacyServiceActivity({ showUnit: async unit =>
    `LoadState=loaded\nActiveState=${unit === "dp-beget-oauth-proxy.service" ? "inactive" : "active"}\n` });
  assert.equal(Object.keys(result).length, LEGACY_UNITS.length);
  assert.equal(result["dp-beget-oauth-proxy.service"], "inactive");
});

test("first migration rejects missing, failing and inactive required services", {
  skip: process.getuid?.() !== 0
}, async () => {
  for (const override of ["LoadState=not-found\nActiveState=inactive\n",
    "LoadState=loaded\nActiveState=failed\n", "LoadState=loaded\nActiveState=inactive\n"]) {
    await assert.rejects(inspectLegacyServiceActivity({ showUnit: async unit => unit === LEGACY_UNITS[0]
      ? override : "LoadState=loaded\nActiveState=active\n" }), /Unexpected legacy service state/);
  }
});

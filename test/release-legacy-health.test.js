import assert from "node:assert/strict";
import test from "node:test";
import { probeLegacyLocalHealth, validateLegacyHealth } from "../scripts/release/probe-legacy-health.mjs";

test("R0003 health proof addresses three distinct loopback ports and the Session Host socket", async () => {
  const seen = [];
  const result = await probeLegacyLocalHealth({ agentPort: 10001, mcpPort: 10002,
    oauthPort: 10003, sessionSocket: "/run/test-session.sock", request: async target => {
      seen.push(target);
      return { status: "ok", product: target.socketPath
        ? "DP Beget Bridge Session Host" : "DP Beget Bridge" };
    } });
  assert.equal(result.services, 4);
  assert.deepEqual(seen.map(target => target.port || target.socketPath),
    [10001, 10002, 10003, "/run/test-session.sock"]);
  assert.equal(seen.every(target => !target.port || target.hostname === "127.0.0.1"), true);
});

test("R0004 health and wrong product cannot be mistaken for legacy recovery", () => {
  assert.throws(() => validateLegacyHealth({ status: "ok", product: "DP Beget Bridge",
    admission: "paused" }, "DP Beget Bridge"), /not R0003/);
  assert.deepEqual(validateLegacyHealth({ status: "ok", product: "DP Beget Bridge",
    inFlightRequests: 0 }, "DP Beget Bridge"),
  { status: "ok", product: "DP Beget Bridge", inFlightRequests: 0 });
  assert.throws(() => validateLegacyHealth({ status: "ok", product: "DP Beget Bridge",
    inFlightRequests: -1 }, "DP Beget Bridge"), /not R0003/);
  assert.throws(() => validateLegacyHealth({ status: "ok", product: "DP Beget Bridge" },
    "DP Beget Bridge", { requireCounter: true }), /not R0003/);
  assert.throws(() => validateLegacyHealth({ status: "ok", product: "DP Beget Bridge" },
    "DP Beget Bridge Session Host"), /not R0003/);
});

test("one invalid service health rejects the four-service proof", async () => {
  await assert.rejects(probeLegacyLocalHealth({ request: async target => ({ status: "ok",
    product: target.port === 8788 ? "unexpected" : target.socketPath
      ? "DP Beget Bridge Session Host" : "DP Beget Bridge" }) }), /not R0003/);
});

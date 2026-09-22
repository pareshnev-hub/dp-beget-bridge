import assert from "node:assert/strict";
import test from "node:test";
import { waitForTunnelReady } from "../scripts/deploy/wait-tunnel-ready.mjs";

test("DP-017 core update waits through the tunnel startup race", async () => {
  let attempts = 0;
  await waitForTunnelReady({
    timeoutMs: 1000,
    intervalMs: 1,
    async fetchImpl() {
      attempts += 1;
      if (attempts < 4) throw new Error("listener not ready");
      return { ok: true, status: 200 };
    },
  });
  assert.equal(attempts, 4);
});

test("DP-017 core update fails closed when tunnel readiness never arrives", async () => {
  await assert.rejects(
    waitForTunnelReady({
      timeoutMs: 20,
      intervalMs: 1,
      async fetchImpl() { return { ok: false, status: 503 }; },
    }),
    /Tunnel readiness did not pass/,
  );
});

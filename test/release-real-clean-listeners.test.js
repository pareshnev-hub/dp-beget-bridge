import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { inspectCleanInstallListeners } from "../scripts/release/preflight-clean-install.mjs";
import { inspectCleanRunningListeners } from "../scripts/release/inspect-clean-systemd-boundary.mjs";

// Reserved ports are used only on the explicitly enabled disposable Linux CI
// runner. The sockets carry no application traffic or credentials.
test("OPS-01: real ss inventory proves both loopback listeners and rejects exposure", async t => {
  if (process.env.DP_TEST_REAL_LISTENERS !== "1" || process.platform !== "linux") {
    t.skip("requires an explicitly enabled disposable Linux runner");
    return;
  }
  await inspectCleanInstallListeners();
  const servers = new Set();
  const close = async server => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    servers.delete(server);
  };
  t.after(async () => {
    for (const server of servers) if (server.listening) await close(server);
  });
  const listen = async (port, host) => {
    const server = net.createServer(socket => socket.destroy());
    servers.add(server);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port, host, exclusive: true }, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    return server;
  };
  await assert.rejects(inspectCleanRunningListeners(), /incomplete/);
  const agent = await listen(8787, "127.0.0.1");
  await assert.rejects(inspectCleanRunningListeners(), /incomplete/);
  const mcp = await listen(8788, "127.0.0.1");
  assert.deepEqual(await inspectCleanRunningListeners(), { directPorts: "loopback-bound" });
  await assert.rejects(inspectCleanInstallListeners(), /already occupied/);
  await close(mcp);
  const exposed = await listen(8788, "0.0.0.0");
  await assert.rejects(inspectCleanRunningListeners(), /non-loopback/);
  await close(exposed);
  await close(agent);
  assert.deepEqual(await inspectCleanInstallListeners(), { directPorts: "unoccupied" });
});

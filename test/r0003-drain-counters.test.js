import assert from "node:assert/strict";
import test from "node:test";
import { createAgentServer } from "../apps/agent/src/server.js";
import { createMcpHttpServer } from "../apps/mcp/src/server.js";
import { createSessionHostServer } from "../apps/session-host/src/server.js";

const logger = { debug() {}, error() {} };

async function verifyCounter(t, server, pathname, headers = {}) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = async () => (await fetch(`${base}/health`)).json();
  assert.equal((await health()).inFlightRequests, 0);
  const active = fetch(`${base}${pathname}`, { headers });
  return { health, active };
}

test("R0003 Agent and Session Host count live handlers without counting health", async t => {
  for (const kind of ["agent", "session"]) {
    let release;
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const sessions = { async list() {
      entered();
      return new Promise(resolve => { release = resolve; });
    } };
    const server = kind === "agent"
      ? createAgentServer({ config: { agentId: "test", token: "secret" }, sessions, files: {}, logger })
      : createSessionHostServer({ sessions, logger });
    const { health, active } = await verifyCounter(t, server, "/v1/sessions",
      kind === "agent" ? { authorization: "Bearer secret" } : {});
    await started;
    assert.equal((await health()).inFlightRequests, 1);
    release([]);
    assert.equal((await active).status, 200);
    assert.equal((await health()).inFlightRequests, 0);
  }
});

test("R0003 MCP counts a pending download through its final response", async t => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const server = createMcpHttpServer({ config: { path: "/mcp" },
    agent: { async downloadPath() {
      entered();
      return new Promise(resolve => { release = resolve; });
    } },
    downloads: { get: () => ({ filePath: "/tmp/test.txt" }) }, logger });
  const { health, active } = await verifyCounter(t, server, "/download/test");
  await started;
  assert.equal((await health()).inFlightRequests, 1);
  release({ headers: new Headers(), body: new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("ok")); controller.close(); }
  }) });
  assert.equal(await (await active).text(), "ok");
  assert.equal((await health()).inFlightRequests, 0);
});

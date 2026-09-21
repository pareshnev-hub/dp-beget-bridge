import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { SessionHostClient } from "../apps/agent/src/session-host-client.js";
import { createSessionHostServer } from "../apps/session-host/src/server.js";

const execFileAsync = promisify(execFile);

const logger = { debug() {}, error() {} };

test("Agent delegates terminal lifecycle over a Unix socket", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-session-host-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  const calls = [];
  const sessions = {
    async list() { calls.push(["list"]); return [{ id: "one", alive: true }]; },
    async open(input) { calls.push(["open", input]); return { id: "one", ...input, alive: true }; },
    async runCommand(id, command, waitMs, idempotencyKey) {
      calls.push(["run", id, command, waitMs, idempotencyKey]);
      return { sessionId: id, state: "running" };
    },
    async readOutput(id, cursor, maxBytes) {
      calls.push(["read", id, cursor, maxBytes]);
      return { sessionId: id, cursor: 4, output: "test", alive: true };
    },
    async sendInput(id, input, enter) { calls.push(["input", id, input, enter]); return { accepted: true }; },
    async interrupt(id) { calls.push(["interrupt", id]); return { interrupted: true }; },
    async close(id, keepOutput) { calls.push(["close", id, keepOutput]); return { closed: true }; },
  };
  const server = createSessionHostServer({ sessions, logger });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const client = new SessionHostClient({ host: "127.0.0.1", port });
  assert.deepEqual(await client.list(), [{ id: "one", alive: true }]);
  assert.equal((await client.open({ cwd: ".", label: "test" })).id, "one");
  assert.equal((await client.runCommand("one", "sleep 1", 50, "session-host-test")).state, "running");
  assert.equal((await client.readOutput("one", 0, 100)).output, "test");
  assert.equal((await client.sendInput("one", "yes", true)).accepted, true);
  assert.equal((await client.interrupt("one")).interrupted, true);
  assert.equal((await client.close("one", false)).closed, true);
  assert.deepEqual(calls, [
    ["list"],
    ["open", { cwd: ".", label: "test" }],
    ["run", "one", "sleep 1", 50, "session-host-test"],
    ["read", "one", "0", "100"],
    ["input", "one", "yes", true],
    ["interrupt", "one"],
    ["close", "one", false],
  ]);
});

test("Session Host refuses Agent or MCP credentials", async () => {
  await assert.rejects(
    execFileAsync(process.execPath, ["apps/session-host/src/index.js"], {
      cwd: process.cwd(),
      env: { ...process.env, DP_AGENT_TOKEN: "must-not-cross-the-boundary" },
      encoding: "utf8",
    }),
    (error) => {
      assert.match(error.stderr, /refuses to start with Agent or MCP credentials/);
      return true;
    },
  );
});

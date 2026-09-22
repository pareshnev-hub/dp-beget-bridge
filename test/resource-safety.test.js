import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FileManager } from "../apps/agent/src/files.js";
import { createMcpHttpServer } from "../apps/mcp/src/server.js";
import { PathPolicy } from "../packages/core/src/path-policy.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class MeasuredSource extends Readable {
  constructor(totalBytes) {
    super({ highWaterMark: 64 * 1024 });
    this.remaining = totalBytes;
    this.generated = 0;
    this.chunk = Buffer.alloc(64 * 1024, 0x61);
  }

  _read() {
    while (this.remaining > 0) {
      const size = Math.min(this.chunk.length, this.remaining);
      this.remaining -= size;
      this.generated += size;
      if (!this.push(this.chunk.subarray(0, size))) return;
    }
    this.push(null);
  }
}

test("STR-01: paused download stays bounded and disconnect cancels upstream", async (t) => {
  const payloadBytes = 128 * 1024 * 1024;
  const source = new MeasuredSource(payloadBytes);
  let upstreamSignal;
  const agent = {
    async downloadPath(_candidate, { signal }) {
      upstreamSignal = signal;
      return {
        headers: new Headers({ "content-length": String(payloadBytes) }),
        body: Readable.toWeb(source),
      };
    },
  };
  const server = createMcpHttpServer({
    config: { path: "/mcp", accessToken: "x".repeat(32) },
    agent,
    downloads: { get: () => ({ filePath: "bounded.bin" }) },
    logger,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baselineRss = process.memoryUsage().rss;
  const response = await new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${server.address().port}/download/test`, resolve);
    request.once("error", reject);
  });
  response.pause();
  await delay(250);
  const rssGrowth = process.memoryUsage().rss - baselineRss;
  assert.ok(source.generated < 16 * 1024 * 1024, `generated ${source.generated} bytes while downstream was paused`);
  assert.ok(rssGrowth < 32 * 1024 * 1024, `RSS grew by ${rssGrowth} bytes for a ${payloadBytes}-byte payload`);
  response.destroy();
  await Promise.race([
    new Promise((resolve) => source.once("close", resolve)),
    delay(1000).then(() => { throw new Error("upstream source was not closed after downstream disconnect"); }),
  ]);
  assert.equal(upstreamSignal.aborted, true);
});

test("STR-02: aggregate file transfer concurrency rejects instead of queueing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-transfer-cap-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new FileManager({
    pathPolicy: new PathPolicy([root]),
    logger,
    uploadMaxBytes: 1024,
    maxConcurrent: 1,
  });
  const release = manager.acquireTransfer("download");
  assert.throws(
    () => manager.acquireTransfer("upload"),
    (error) => error?.code === "transfer_busy" && error?.status === 429,
  );
  release();
  manager.acquireTransfer("upload")();
  assert.equal(manager.activeTransfers, 0);
});

test("STR-04: upload admission preserves configured free disk reserve", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-storage-reserve-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fileSystem = {
    ...fs,
    async statfs() { return { bavail: 8n, bsize: 1024n }; },
  };
  const manager = new FileManager({
    pathPolicy: new PathPolicy([root]),
    logger,
    uploadMaxBytes: 1024,
    storageMinFreeBytes: 16 * 1024,
    fileSystem,
  });
  await assert.rejects(
    manager.upload(Readable.from("blocked"), "blocked.txt"),
    (error) => error?.code === "storage_reserve" && error?.status === 507,
  );
  await assert.rejects(fs.access(path.join(root, "blocked.txt")), { code: "ENOENT" });
  assert.equal(manager.activeTransfers, 0);
});

test("STR-05: production systemd units define task, fd, memory and swap ceilings", async () => {
  for (const name of ["agent", "mcp", "session-host"]) {
    const unit = await fs.readFile(new URL(`../deploy/systemd/dp-beget-${name}.service`, import.meta.url), "utf8");
    assert.match(unit, /^TasksMax=\d+$/m);
    assert.match(unit, /^LimitNOFILE=\d+$/m);
    assert.match(unit, /^MemoryMax=\d+[MG]$/m);
    assert.match(unit, /^MemorySwapMax=\d+[MG]$/m);
    assert.match(unit, /^NoNewPrivileges=true$/m);
  }
});

test("STR-03: capture helper streams immediately and stops at the exact byte ceiling", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-capture-helper-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, "terminal.log");
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../scripts/transcript-capture.mjs", import.meta.url)),
    output,
    "5",
  ], { stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.end("123456789");
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(await fs.readFile(output, "utf8"), "12345");
});

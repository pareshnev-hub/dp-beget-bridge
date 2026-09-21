import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { FileManager } from "../apps/agent/src/files.js";
import { PathPolicy } from "../packages/core/src/path-policy.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };

test("uploads, lists, copies, moves, and deletes files inside allowed roots", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-files-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new FileManager({ pathPolicy: new PathPolicy([root]), logger, uploadMaxBytes: 1024 });

  const uploaded = await manager.upload(Readable.from("hello"), "incoming/hello.txt");
  assert.equal(uploaded.size, 5);
  assert.equal(await fs.readFile(path.join(root, "incoming/hello.txt"), "utf8"), "hello");
  assert.equal((await manager.list("incoming")).entries[0].name, "hello.txt");
  await manager.copy("incoming/hello.txt", "copy.txt");
  await manager.move("copy.txt", "moved.txt");
  assert.equal(await fs.readFile(path.join(root, "moved.txt"), "utf8"), "hello");
  await manager.remove("moved.txt");
  await assert.rejects(fs.access(path.join(root, "moved.txt")));
});

test("rejects uploads over the configured size", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-files-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new FileManager({ pathPolicy: new PathPolicy([root]), logger, uploadMaxBytes: 3 });
  await assert.rejects(manager.upload(Readable.from("hello"), "too-large.txt"), /configured limit/);
});

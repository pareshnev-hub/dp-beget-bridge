import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { FileManager } from "../apps/agent/src/files.js";
import { PathPolicy } from "../packages/core/src/path-policy.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };

async function createFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-files-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new FileManager({
    pathPolicy: new PathPolicy([root]),
    logger,
    uploadMaxBytes: 1024,
    ...options,
  });
  return { root, manager };
}

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

test("download metadata reports exact size and SHA-256", async (t) => {
  const { root, manager } = await createFixture(t);
  await fs.writeFile(path.join(root, "canary.txt"), "hello");

  const metadata = await manager.metadata("canary.txt");

  assert.equal(metadata.size, 5);
  assert.match(metadata.modifiedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(metadata.sha256, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.equal(manager.activeTransfers, 0);
});

test("rejects uploads over the configured size", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-files-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = new FileManager({ pathPolicy: new PathPolicy([root]), logger, uploadMaxBytes: 3 });
  await assert.rejects(manager.upload(Readable.from("hello"), "too-large.txt"), /configured limit/);
});

test("FILE-10: interrupted upload removes temporary state and never commits", async (t) => {
  const { root, manager } = await createFixture(t);
  const interrupted = Readable.from((async function* stream() {
    yield "partial";
    throw Object.assign(new Error("client disconnected"), { code: "ECONNRESET" });
  })());

  await assert.rejects(
    manager.upload(interrupted, "interrupted.txt"),
    (error) => error?.code === "ECONNRESET",
  );

  await assert.rejects(fs.access(path.join(root, "interrupted.txt")), { code: "ENOENT" });
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.startsWith(".dpb-part-")), []);
  assert.equal(manager.activeTransfers, 0);
});

test("FILE-11: mid-stream ENOSPC preserves destination and removes temporary state", async (t) => {
  const diskFull = Object.assign(new Error("injected disk full"), { code: "ENOSPC" });
  const createWriteStream = (temporary) => new Writable({
    write(chunk, _encoding, callback) {
      fs.writeFile(temporary, chunk).then(() => callback(diskFull), callback);
    },
  });
  const { root, manager } = await createFixture(t, { createWriteStream });
  const destination = path.join(root, "existing.txt");
  await fs.writeFile(destination, "original");

  await assert.rejects(
    manager.upload(Readable.from("replacement"), "existing.txt", true),
    (error) => error?.code === "ENOSPC",
  );

  assert.equal(await fs.readFile(destination, "utf8"), "original");
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.startsWith(".dpb-part-")), []);
  assert.equal(manager.activeTransfers, 0);
});

test("FILE-01: moving a path onto itself is a non-destructive no-op", async (t) => {
  const { root, manager } = await createFixture(t);
  const target = path.join(root, "same.txt");
  await fs.writeFile(target, "keep-me");

  const result = await manager.move("same.txt", "same.txt", true);

  assert.deepEqual(result, {
    source: target,
    destination: target,
    moved: false,
    reason: "same_path",
  });
  assert.equal(await fs.readFile(target, "utf8"), "keep-me");
});

test("FILE-02: missing source never changes an existing destination", async (t) => {
  const { root, manager } = await createFixture(t);
  const destination = path.join(root, "destination.txt");
  await fs.writeFile(destination, "original-destination");

  await assert.rejects(
    manager.move("missing.txt", "destination.txt", true),
    (error) => error?.code === "ENOENT",
  );

  assert.equal(await fs.readFile(destination, "utf8"), "original-destination");
});

test("FILE-03: rename failure preserves both source and destination", async (t) => {
  const renameError = Object.assign(new Error("injected rename failure"), { code: "EACCES" });
  const fileSystem = { ...fs, rename: async () => { throw renameError; } };
  const { root, manager } = await createFixture(t, { fileSystem });
  const source = path.join(root, "source.txt");
  const destination = path.join(root, "destination.txt");
  await fs.writeFile(source, "source-data");
  await fs.writeFile(destination, "destination-data");

  await assert.rejects(
    manager.move("source.txt", "destination.txt", true),
    (error) => error === renameError,
  );

  assert.equal(await fs.readFile(source, "utf8"), "source-data");
  assert.equal(await fs.readFile(destination, "utf8"), "destination-data");
});

test("overwrite move replaces an existing regular file without pre-delete", async (t) => {
  const { root, manager } = await createFixture(t);
  const source = path.join(root, "source.txt");
  const destination = path.join(root, "destination.txt");
  await fs.writeFile(source, "new-data");
  await fs.writeFile(destination, "old-data");

  const result = await manager.move("source.txt", "destination.txt", true);

  assert.equal(result.moved, true);
  assert.equal(await fs.readFile(destination, "utf8"), "new-data");
  await assert.rejects(fs.access(source), (error) => error?.code === "ENOENT");
});

test("FILE-09: EXDEV is unsupported and performs no partial mutation", async (t) => {
  const exdev = Object.assign(new Error("cross-device link"), { code: "EXDEV" });
  const fileSystem = { ...fs, rename: async () => { throw exdev; } };
  const { root, manager } = await createFixture(t, { fileSystem });
  const source = path.join(root, "source.txt");
  const destination = path.join(root, "destination.txt");
  await fs.writeFile(source, "source-data");
  await fs.writeFile(destination, "destination-data");

  await assert.rejects(
    manager.move("source.txt", "destination.txt", true),
    (error) => error?.code === "unsupported_cross_device_move",
  );

  assert.equal(await fs.readFile(source, "utf8"), "source-data");
  assert.equal(await fs.readFile(destination, "utf8"), "destination-data");
});

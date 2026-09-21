import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { FileManager } from "../../apps/agent/src/files.js";
import { PathPolicy } from "../../packages/core/src/path-policy.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };

async function fixture(t, { fileSystem = fsp, policyFileSystem = fsp } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dpb-mutation-root-"));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "dpb-mutation-outside-"));
  t.after(() => Promise.all([
    fsp.rm(root, { recursive: true, force: true }),
    fsp.rm(outside, { recursive: true, force: true }),
  ]));
  const manager = new FileManager({
    pathPolicy: new PathPolicy([root], { fileSystem: policyFileSystem }),
    logger,
    uploadMaxBytes: 1024,
    fileSystem,
  });
  return { root, outside, manager };
}

function racingFileSystem(onLink) {
  return {
    ...fsp,
    async link(source, destination) {
      await onLink(destination);
      return fsp.link(source, destination);
    },
  };
}

test("FILE-04: overwrite=false never replaces a concurrently-created destination", async (t) => {
  await t.test("upload commit", async (t) => {
    const fileSystem = racingFileSystem((destination) => fsp.writeFile(destination, "racer"));
    const { root, manager } = await fixture(t, { fileSystem });
    await assert.rejects(
      manager.upload(Readable.from("uploaded"), "destination.txt", false),
      (error) => error?.code === "destination_exists",
    );
    assert.equal(await fsp.readFile(path.join(root, "destination.txt"), "utf8"), "racer");
  });

  await t.test("copy commit", async (t) => {
    const fileSystem = racingFileSystem((destination) => fsp.writeFile(destination, "racer"));
    const { root, manager } = await fixture(t, { fileSystem });
    await fsp.writeFile(path.join(root, "source.txt"), "source");
    await assert.rejects(
      manager.copy("source.txt", "destination.txt", false),
      (error) => error?.code === "destination_exists",
    );
    assert.equal(await fsp.readFile(path.join(root, "source.txt"), "utf8"), "source");
    assert.equal(await fsp.readFile(path.join(root, "destination.txt"), "utf8"), "racer");
  });

  await t.test("move commit", async (t) => {
    const fileSystem = racingFileSystem((destination) => fsp.writeFile(destination, "racer"));
    const { root, manager } = await fixture(t, { fileSystem });
    await fsp.writeFile(path.join(root, "source.txt"), "source");
    await assert.rejects(
      manager.move("source.txt", "destination.txt", false),
      (error) => error?.code === "destination_exists",
    );
    assert.equal(await fsp.readFile(path.join(root, "source.txt"), "utf8"), "source");
    assert.equal(await fsp.readFile(path.join(root, "destination.txt"), "utf8"), "racer");
  });
});

test("FILE-05: configured root deletion is denied", async (t) => {
  const { root, manager } = await fixture(t);
  await fsp.writeFile(path.join(root, "keep.txt"), "keep");
  await assert.rejects(
    manager.remove(".", true),
    (error) => error?.code === "protected_workspace_root",
  );
  assert.equal(await fsp.readFile(path.join(root, "keep.txt"), "utf8"), "keep");
});

test("FILE-06: configured root cannot be a move source or destination", async (t) => {
  const { root, manager } = await fixture(t);
  await fsp.writeFile(path.join(root, "keep.txt"), "keep");
  await assert.rejects(
    manager.move(".", "moved-root", false),
    (error) => error?.code === "protected_workspace_root",
  );
  await assert.rejects(
    manager.move("keep.txt", ".", true),
    (error) => error?.code === "protected_workspace_root",
  );
  assert.equal(await fsp.readFile(path.join(root, "keep.txt"), "utf8"), "keep");
});

test("FILE-07: symlink swaps cannot redirect a mutation outside the pinned root", async (t) => {
  const { root, outside } = await fixture(t);
  const safe = path.join(root, "safe");
  const displaced = path.join(root, "safe-displaced");
  await fsp.mkdir(safe);
  await fsp.writeFile(path.join(safe, "victim.txt"), "inside");
  await fsp.writeFile(path.join(outside, "victim.txt"), "outside");
  let swapped = false;
  const fileSystem = {
    ...fsp,
    async lstat(candidate) {
      if (!swapped && candidate.startsWith("/proc/self/fd/")) {
        swapped = true;
        await fsp.rename(safe, displaced);
        await fsp.symlink(outside, safe);
      }
      return fsp.lstat(candidate);
    },
  };
  const manager = new FileManager({
    pathPolicy: new PathPolicy([root]),
    logger,
    uploadMaxBytes: 1024,
    fileSystem,
  });

  await manager.remove("safe/victim.txt", false);

  assert.equal(swapped, true);
  assert.equal(await fsp.readFile(path.join(outside, "victim.txt"), "utf8"), "outside");
  await assert.rejects(fsp.access(path.join(displaced, "victim.txt")), { code: "ENOENT" });
});

test("FILE-07: a symlink inserted before a parent is pinned fails closed", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dpb-mutation-root-"));
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "dpb-mutation-outside-"));
  t.after(() => Promise.all([
    fsp.rm(root, { recursive: true, force: true }),
    fsp.rm(outside, { recursive: true, force: true }),
  ]));
  const safe = path.join(root, "safe");
  await fsp.mkdir(safe);
  await fsp.writeFile(path.join(outside, "victim.txt"), "outside");
  let swapped = false;
  const policyFileSystem = {
    ...fsp,
    async open(candidate, flags, mode) {
      if (!swapped && candidate.startsWith("/proc/self/fd/") && candidate.endsWith("/safe")) {
        swapped = true;
        await fsp.rmdir(safe);
        await fsp.symlink(outside, safe);
      }
      return fsp.open(candidate, flags, mode);
    },
  };
  const manager = new FileManager({
    pathPolicy: new PathPolicy([root], { fileSystem: policyFileSystem }),
    logger,
    uploadMaxBytes: 1024,
  });

  await assert.rejects(
    manager.remove("safe/victim.txt", false),
    (error) => error?.code === "path_not_allowed",
  );
  assert.equal(await fsp.readFile(path.join(outside, "victim.txt"), "utf8"), "outside");
});

test("FILE-08: dangerous ancestor and descendant copy/move overlaps are rejected", async (t) => {
  const { root, manager } = await fixture(t);
  await fsp.mkdir(path.join(root, "tree", "child"), { recursive: true });
  await fsp.writeFile(path.join(root, "tree", "keep.txt"), "keep");
  for (const operation of ["copy", "move"]) {
    await assert.rejects(
      manager[operation]("tree", "tree/child/nested", false),
      (error) => error?.code === "dangerous_path_overlap",
    );
    await assert.rejects(
      manager[operation]("tree/child", "tree", true),
      (error) => error?.code === "dangerous_path_overlap",
    );
  }
  assert.equal(await fsp.readFile(path.join(root, "tree", "keep.txt"), "utf8"), "keep");
});

test("FILE-09: recursive and complex directory mutations fail explicitly without partial changes", async (t) => {
  const { root, manager } = await fixture(t);
  await fsp.mkdir(path.join(root, "tree"));
  await fsp.writeFile(path.join(root, "tree", "keep.txt"), "tree-data");
  await fsp.writeFile(path.join(root, "unrelated.txt"), "unrelated-data");

  for (const action of [
    () => manager.copy("tree", "tree-copy", false),
    () => manager.move("tree", "tree-moved", false),
    () => manager.remove("tree", true),
  ]) {
    await assert.rejects(action(), (error) => error?.code === "unsupported_complex_mutation");
  }

  assert.equal(await fsp.readFile(path.join(root, "tree", "keep.txt"), "utf8"), "tree-data");
  assert.equal(await fsp.readFile(path.join(root, "unrelated.txt"), "utf8"), "unrelated-data");
  await assert.rejects(fsp.access(path.join(root, "tree-copy")), { code: "ENOENT" });
  await assert.rejects(fsp.access(path.join(root, "tree-moved")), { code: "ENOENT" });
});

test("FILE-09: a failed no-replace move cleanup rolls back its destination link", async (t) => {
  let unlinkCalls = 0;
  const unlinkFailure = Object.assign(new Error("injected source unlink failure"), { code: "EACCES" });
  const fileSystem = {
    ...fsp,
    async unlink(candidate) {
      unlinkCalls += 1;
      if (unlinkCalls === 1) throw unlinkFailure;
      return fsp.unlink(candidate);
    },
  };
  const { root, manager } = await fixture(t, { fileSystem });
  await fsp.writeFile(path.join(root, "source.txt"), "source");

  await assert.rejects(
    manager.move("source.txt", "destination.txt", false),
    (error) => error === unlinkFailure,
  );

  assert.equal(await fsp.readFile(path.join(root, "source.txt"), "utf8"), "source");
  await assert.rejects(fsp.access(path.join(root, "destination.txt")), { code: "ENOENT" });
});

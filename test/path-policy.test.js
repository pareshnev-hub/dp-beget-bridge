import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PathPolicy } from "../packages/core/src/path-policy.js";

test("resolves relative paths under the first allowed root", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-policy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const policy = new PathPolicy([root]);
  assert.equal(policy.resolve("uploads/file.txt"), path.join(root, "uploads", "file.txt"));
  assert.throws(() => policy.resolve("../outside"), /outside configured roots/);
});

test("blocks escape through symlinks", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-policy-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-outside-"));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true }),
  ]));
  await fs.symlink(outside, path.join(root, "escape"));
  const policy = new PathPolicy([root]);
  assert.throws(() => policy.resolve("escape/secret.txt"), /resolves outside configured roots/);
});

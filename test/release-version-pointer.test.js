import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readlink, rmdir, stat, symlink, unlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { switchVersion } from "../scripts/release/version-pointer.mjs";

const oldVersion = `0.1.0-${"a".repeat(40)}`;
const newVersion = `0.1.0-${"b".repeat(40)}`;

async function layout(t) {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "dp-activation-"));
  t.after(() => rm(releaseRoot, { recursive: true, force: true }));
  await mkdir(path.join(releaseRoot, "releases"));
  for (const name of [oldVersion, newVersion]) {
    const directory = path.join(releaseRoot, "releases", name);
    await mkdir(directory);
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "dp-beget-bridge", version: "0.1.0" }));
  }
  await symlink(`releases/${oldVersion}`, path.join(releaseRoot, "current"));
  return releaseRoot;
}

test("OPS-07: health success switches the pointer and retains the prior version", async t => {
  const releaseRoot = await layout(t);
  const result = await switchVersion({ releaseRoot, versionDir: newVersion, checkHealthy: async () => {
    assert.equal(await readlink(path.join(releaseRoot, "current")), `releases/${newVersion}`);
  } });
  assert.equal(result.previous, `releases/${oldVersion}`);
  assert.equal(await readlink(path.join(releaseRoot, "previous")), `releases/${oldVersion}`);
});

test("OPS-07: health failure restores the previous pointer without deleting either version", async t => {
  const releaseRoot = await layout(t);
  await assert.rejects(switchVersion({ releaseRoot, versionDir: newVersion,
    checkHealthy: async () => { throw new Error("unhealthy"); } }), /unhealthy/);
  assert.equal(await readlink(path.join(releaseRoot, "current")), `releases/${oldVersion}`);
});

test("OPS-07: an unmanaged current path and a concurrent activation fail before switching", async t => {
  const releaseRoot = await layout(t);
  await mkdir(path.join(releaseRoot, ".activation.lock"));
  await assert.rejects(switchVersion({ releaseRoot, versionDir: newVersion, checkHealthy: async () => {} }), /EEXIST/);
  assert.equal(await readlink(path.join(releaseRoot, "current")), `releases/${oldVersion}`);
  await rmdir(path.join(releaseRoot, ".activation.lock"));
  await unlink(path.join(releaseRoot, "current"));
  await mkdir(path.join(releaseRoot, "current"));
  await assert.rejects(switchVersion({ releaseRoot, versionDir: newVersion, checkHealthy: async () => {} }), /managed symlink/);
});

test("OPS-07: sync failure after pointer rename restores old version", async t => {
  const releaseRoot = await layout(t);
  let syncs = 0;
  await assert.rejects(switchVersion({ releaseRoot, versionDir: newVersion,
    checkHealthy: async () => {}, sync: async () => {
      if (++syncs === 3) throw new Error("directory sync failed");
    } }), /directory sync failed/);
  assert.equal(await readlink(path.join(releaseRoot, "current")), `releases/${oldVersion}`);
  await assert.rejects(stat(path.join(releaseRoot, ".activation.lock")), /ENOENT/);
});

test("OPS-07: failed rollback keeps activation lock for recovery", async t => {
  const releaseRoot = await layout(t);
  let syncs = 0;
  await assert.rejects(switchVersion({ releaseRoot, versionDir: newVersion,
    checkHealthy: async () => { throw new Error("unhealthy"); },
    sync: async () => { if (++syncs === 5) throw new Error("rollback sync failed"); } }),
  /Activation and pointer rollback failed/);
  assert.equal((await stat(path.join(releaseRoot, ".activation.lock"))).isDirectory(), true);
});

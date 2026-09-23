import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installQuarantinedDependencies } from "../scripts/release/install-quarantined-dependencies.mjs";

test("OPS-05: quarantined npm ci does not execute lifecycle scripts", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-install-deps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "extracted");
  await mkdir(directory);
  const pkg = { name: "dp-beget-bridge", version: "1.0.0", scripts: { postinstall: "node -e \"require('fs').writeFileSync('executed', 'bad')\"" } };
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3,
    requires: true, packages: { "": { name: pkg.name, version: pkg.version } } };
  await writeFile(path.join(directory, "package.json"), JSON.stringify(pkg));
  await writeFile(path.join(directory, "package-lock.json"), JSON.stringify(lock));
  assert.deepEqual(await installQuarantinedDependencies({ directory, version: "1.0.0", workspace: root }),
    { directory, version: "1.0.0" });
  await assert.rejects(stat(path.join(directory, "executed")), /ENOENT/);
  await assert.rejects(stat(path.join(root, "npm-cache")), /ENOENT/);
  assert.equal(JSON.parse(await readFile(path.join(directory, "package-lock.json"), "utf8")).version, "1.0.0");
});

test("OPS-05: package/lock identity mismatch fails before npm is invoked", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-install-mismatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "extracted");
  await mkdir(directory);
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "dp-beget-bridge", version: "1.0.0" }));
  await writeFile(path.join(directory, "package-lock.json"), JSON.stringify({ name: "wrong", version: "1.0.0" }));
  await assert.rejects(installQuarantinedDependencies({ directory, version: "1.0.0", workspace: root }), /identity/);
  await assert.rejects(stat(path.join(root, "npm-cache")), /ENOENT/);
});

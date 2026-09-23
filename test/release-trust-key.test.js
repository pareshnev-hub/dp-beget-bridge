import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectReleasePublicKey, loadPinnedReleaseKey, pinReleaseKey } from "../scripts/release/pin-release-key.mjs";

test("OPS-05: release key requires an independent exact PEM fingerprint and Ed25519 type", () => {
  const ed = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  const fingerprint = createHash("sha256").update(ed).digest("hex");
  assert.equal(inspectReleasePublicKey(ed, fingerprint), fingerprint);
  assert.throws(() => inspectReleasePublicKey(ed, "0".repeat(64)), /independent pin/);
  assert.throws(() => inspectReleasePublicKey(ed, "bad"), /fingerprint is required/);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" });
  assert.throws(() => inspectReleasePublicKey(rsa, createHash("sha256").update(rsa).digest("hex")), /Ed25519/);
  assert.throws(() => inspectReleasePublicKey(ed + ed,
    createHash("sha256").update(ed + ed).digest("hex")), /canonical/);
});

test("OPS-05: root-only one-time pin refuses replacement, symlink and writable trust material", { skip: process.getuid?.() !== 0 }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "dp-root-trust-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const parent = path.join(base, "parent");
  const trustDir = path.join(parent, "trust");
  await mkdir(parent, { mode: 0o700 });
  const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  const fingerprint = createHash("sha256").update(key).digest("hex");
  const source = path.join(base, "public.pem");
  await writeFile(source, key);
  await assert.rejects(pinReleaseKey({ source, expectedSha256: "0".repeat(64), trustDir }), /independent pin/);
  await assert.rejects(stat(trustDir), /ENOENT/);
  const pinned = await pinReleaseKey({ source, expectedSha256: fingerprint, trustDir });
  assert.equal(pinned.fingerprint, fingerprint);
  assert.equal(await readFile(pinned.keyFile, "utf8"), key);
  assert.deepEqual(await loadPinnedReleaseKey({ trustDir }), pinned);
  await assert.rejects(pinReleaseKey({ source, expectedSha256: fingerprint, trustDir }), /EEXIST/);
  await rm(pinned.keyFile);
  await symlink(source, pinned.keyFile);
  await assert.rejects(loadPinnedReleaseKey({ trustDir }), /regular file/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyArtifact } from "../scripts/release/verify-artifact.mjs";

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "dp-release-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = Buffer.from("purpose-built release fixture\n");
  const artifact = path.join(dir, "dp-beget-bridge-1.0.0.tar.gz");
  const manifest = path.join(dir, "manifest.json");
  const signature = path.join(dir, "manifest.sig");
  const trustedKey = path.join(dir, "trusted.pem");
  const bytes = Buffer.from(JSON.stringify({
    format: "dp-beget-bridge-release-v1", version: "1.0.0", commit: "a".repeat(40),
    artifact: { name: path.basename(artifact), size: payload.length, sha256: createHash("sha256").update(payload).digest("hex") }
  }));
  await Promise.all([
    writeFile(artifact, payload), writeFile(manifest, bytes),
    writeFile(signature, sign(null, bytes, privateKey).toString("base64") + "\n"),
    writeFile(trustedKey, publicKey.export({ type: "spki", format: "pem" }))
  ]);
  return { artifact, manifest, signature, trustedKey, publicKey, dir };
}

test("OPS-05: accepts an artifact only with a matching trusted signature, size and digest", async t => {
  const inputs = await fixture(t);
  const result = await verifyArtifact(inputs);
  assert.equal(result.version, "1.0.0");
  assert.equal(result.commit, "a".repeat(40));
});

test("OPS-05: rejects modified artifact bytes and modified signed metadata", async t => {
  const inputs = await fixture(t);
  await writeFile(inputs.artifact, "purpose-built release fixturE\n");
  await assert.rejects(verifyArtifact(inputs), /checksum mismatch/);
  const record = JSON.parse(await readFile(inputs.manifest, "utf8"));
  record.commit = "b".repeat(40);
  await writeFile(inputs.manifest, JSON.stringify(record));
  await assert.rejects(verifyArtifact(inputs), /signature verification failed/);
});

test("OPS-05: rejects another signing key and an artifact symlink", async t => {
  const inputs = await fixture(t);
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  await writeFile(inputs.trustedKey, other);
  await assert.rejects(verifyArtifact(inputs), /signature verification failed/);
  await writeFile(inputs.trustedKey, inputs.publicKey.export({ type: "spki", format: "pem" }));
  const subdir = path.join(inputs.dir, "subdir");
  await mkdir(subdir);
  const linked = path.join(subdir, path.basename(inputs.artifact));
  await symlink(inputs.artifact, linked);
  await assert.rejects(verifyArtifact({ ...inputs, artifact: linked }), /ELOOP/);
});

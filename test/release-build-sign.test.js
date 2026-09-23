import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildArtifact } from "../scripts/release/build-artifact.mjs";
import { signManifest } from "../scripts/release/sign-manifest.mjs";
import { verifyArtifact } from "../scripts/release/verify-artifact.mjs";

const exec = promisify(execFile);

test("R0004 candidate build is repeatable for an exact commit and can be signed offline", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "dp-candidate-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const commit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  const first = await buildArtifact({ commit, outputDir: path.join(base, "first") });
  const second = await buildArtifact({ commit, outputDir: path.join(base, "second") });
  assert.deepEqual(await readFile(first.artifact), await readFile(second.artifact));
  assert.deepEqual(await readFile(first.manifest), await readFile(second.manifest));
  assert.equal(JSON.parse(await readFile(first.manifest, "utf8")).commit, commit);
  const { stdout: listing } = await exec("tar", ["-tzf", first.artifact]);
  assert.match(listing, /dp-beget-bridge-0\.1\.0\/package\.json/);
  assert.doesNotMatch(listing, /node_modules|\.git\//);

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateFile = path.join(base, "release-private.pem");
  const publicFile = path.join(base, "trusted-public.pem");
  const signature = path.join(base, "manifest.sig");
  await writeFile(privateFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await writeFile(publicFile, publicKey.export({ type: "spki", format: "pem" }));
  await signManifest({ artifact: first.artifact, manifest: first.manifest, privateKey: privateFile, signature });
  const result = await verifyArtifact({ artifact: first.artifact, manifest: first.manifest, signature, trustedKey: publicFile });
  assert.equal(result.commit, commit);
  assert.equal((await stat(signature)).mode & 0o777, 0o600);
  await assert.rejects(buildArtifact({ commit, outputDir: path.join(base, "first") }), /EEXIST/);
});

test("signing refuses an unsafe key and a candidate with mismatched bytes", async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "dp-candidate-negative-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const commit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  const candidate = await buildArtifact({ commit, outputDir: path.join(base, "candidate") });
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateFile = path.join(base, "key.pem");
  const signature = path.join(base, "signature");
  await writeFile(privateFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o644 });
  const args = { artifact: candidate.artifact, manifest: candidate.manifest, privateKey: privateFile, signature };
  await assert.rejects(signManifest(args), /mode 0600/);
  await rm(privateFile);
  await writeFile(privateFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await writeFile(candidate.artifact, "changed bytes");
  await assert.rejects(signManifest(args), /size mismatch/);
  await assert.rejects(stat(signature), /ENOENT/);
});

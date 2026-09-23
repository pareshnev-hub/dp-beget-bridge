import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildArtifact } from "../scripts/release/build-artifact.mjs";
import { signManifest } from "../scripts/release/sign-manifest.mjs";
import { stageVerifiedArtifact } from "../scripts/release/stage-verified-artifact.mjs";
import { verifyArtifact } from "../scripts/release/verify-artifact.mjs";

const exec = promisify(execFile);

async function signedCandidate(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "dp-stage-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const commit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  const candidate = await buildArtifact({ commit, outputDir: path.join(base, "candidate") });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateFile = path.join(base, "private.pem");
  const trustedKey = path.join(base, "trusted.pem");
  const signature = path.join(base, "candidate", "manifest.sig");
  await writeFile(privateFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await writeFile(trustedKey, publicKey.export({ type: "spki", format: "pem" }));
  await signManifest({ ...candidate, privateKey: privateFile, signature });
  return { ...candidate, signature, trustedKey, stageDir: path.join(base, "stage"), base };
}

test("OPS-05: stage copies exactly the authenticated candidate into a private new directory", async t => {
  const candidate = await signedCandidate(t);
  const staged = await stageVerifiedArtifact(candidate);
  assert.deepEqual(await readFile(staged.artifact), await readFile(candidate.artifact));
  assert.equal((await stat(candidate.stageDir)).mode & 0o777, 0o700);
  assert.equal((await stat(staged.artifact)).mode & 0o777, 0o600);
  assert.equal((await verifyArtifact(staged)).sha256, staged.sha256);
  await assert.rejects(stageVerifiedArtifact(candidate), /EEXIST/);
});

test("OPS-05: invalid signature or archive fails before stage mutation", async t => {
  const candidate = await signedCandidate(t);
  await writeFile(candidate.artifact, "not the signed archive");
  await assert.rejects(stageVerifiedArtifact(candidate), /size mismatch/);
  await assert.rejects(stat(candidate.stageDir), /ENOENT/);
});

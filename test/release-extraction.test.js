import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { buildArtifact } from "../scripts/release/build-artifact.mjs";
import { signManifest } from "../scripts/release/sign-manifest.mjs";
import { extractVerifiedArtifact } from "../scripts/release/extract-verified-artifact.mjs";

const exec = promisify(execFile);

async function candidate(t, mutate) {
  const base = await mkdtemp(path.join(os.tmpdir(), "dp-extraction-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const commit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  const built = await buildArtifact({ commit, outputDir: path.join(base, "candidate") });
  if (mutate) {
    const tar = gunzipSync(await readFile(built.artifact));
    mutate(tar);
    const changed = gzipSync(tar, { mtime: 0 });
    await writeFile(built.artifact, changed);
    const record = JSON.parse(await readFile(built.manifest, "utf8"));
    record.artifact.size = changed.length;
    record.artifact.sha256 = createHash("sha256").update(changed).digest("hex");
    await writeFile(built.manifest, JSON.stringify(record));
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateFile = path.join(base, "private.pem");
  const trustedKey = path.join(base, "trusted.pem");
  const signature = path.join(base, "manifest.sig");
  await writeFile(privateFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await writeFile(trustedKey, publicKey.export({ type: "spki", format: "pem" }));
  await signManifest({ ...built, privateKey: privateFile, signature });
  return { ...built, signature, trustedKey, outputDir: path.join(base, "extracted"), base };
}

function updateChecksum(bytes, offset) {
  bytes.fill(32, offset + 148, offset + 156);
  let checksum = 0;
  for (const byte of bytes.subarray(offset, offset + 512)) checksum += byte;
  bytes.write(`${checksum.toString(8).padStart(6, "0")}\0 `, offset + 148, "ascii");
}

test("R0004 extraction creates only private regular files and directories from a verified archive", async t => {
  const input = await candidate(t);
  const result = await extractVerifiedArtifact(input);
  assert.equal(result.commit, input.commit);
  assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(await readFile(path.join(result.directory, "package.json"), "utf8")).name, "dp-beget-bridge");
  await assert.rejects(extractVerifiedArtifact(input), /EEXIST/);
});

test("R0004 extraction rejects a signed symlink entry before writing files", async t => {
  const input = await candidate(t, bytes => {
    // git archive: global PAX header, root directory, then the first regular file.
    const fileHeader = 3 * 512;
    bytes[fileHeader + 156] = "2".charCodeAt(0);
    updateChecksum(bytes, fileHeader);
  });
  await assert.rejects(extractVerifiedArtifact(input), /links or special entries/);
  await assert.rejects(stat(input.outputDir), /ENOENT/);
});

test("R0004 extraction rejects a signed traversal path before writing files", async t => {
  const input = await candidate(t, bytes => {
    const fileHeader = 3 * 512;
    bytes.fill(0, fileHeader, fileHeader + 100);
    bytes.write("dp-beget-bridge-0.1.0/../escape", fileHeader, "ascii");
    updateChecksum(bytes, fileHeader);
  });
  await assert.rejects(extractVerifiedArtifact(input), /Unsafe archive path/);
  await assert.rejects(stat(input.outputDir), /ENOENT/);
});

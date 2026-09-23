#!/usr/bin/env node
import { constants } from "node:fs";
import { open, mkdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { verifyArtifact } from "./verify-artifact.mjs";

async function copyNoFollow(source, destination, maxBytes) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const sourceStat = await input.stat();
    if (!sourceStat.isFile() || sourceStat.size > maxBytes) throw new Error("Release input exceeds its signed size limit");
    const output = await open(destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      let bytes = 0;
      const limit = new Transform({ transform(chunk, _, callback) {
        bytes += chunk.length;
        callback(bytes > maxBytes ? new Error("Release input exceeds its signed size limit") : null, chunk);
      } });
      await pipeline(input.createReadStream(), limit, output.createWriteStream());
    } finally { await output.close(); }
  } finally { await input.close(); }
}

export async function stageVerifiedArtifact({ artifact, manifest, signature, trustedKey, stageDir }) {
  if (typeof stageDir !== "string" || !stageDir) throw new Error("A new private stage directory is required");
  const sources = [artifact, manifest, signature, trustedKey].map(value => path.resolve(value));
  const target = path.resolve(stageDir);
  if (sources.some(value => value === target || value.startsWith(`${target}${path.sep}`))) {
    throw new Error("Release inputs must be outside the stage directory");
  }
  // Reject unauthenticated inputs before creating the stage directory.
  const first = await verifyArtifact({ artifact, manifest, signature, trustedKey });
  await mkdir(target, { mode: 0o700 });
  const staged = {
    artifact: path.join(target, path.basename(artifact)),
    manifest: path.join(target, "manifest.json"),
    signature: path.join(target, "manifest.sig"),
    trustedKey
  };
  const created = [];
  try {
    for (const [source, destination, maxBytes] of [
      [artifact, staged.artifact, first.size], [manifest, staged.manifest, 16 * 1024], [signature, staged.signature, 4 * 1024]
    ]) {
      created.push(destination);
      await copyNoFollow(source, destination, maxBytes);
    }
    // The installer will use only these staged bytes. A source-path substitution
    // between the first check and copying cannot create a valid staged release.
    const second = await verifyArtifact(staged);
    if (first.commit !== second.commit || first.sha256 !== second.sha256) {
      throw new Error("Release candidate changed during staging");
    }
    return { ...staged, version: second.version, commit: second.commit, sha256: second.sha256 };
  } catch (error) {
    for (const filename of created.reverse()) await rm(filename, { force: true }).catch(() => {});
    await rmdir(target).catch(() => {});
    throw error;
  }
}

async function main(args) {
  if (args.length !== 10 || args[0] !== "--artifact" || args[2] !== "--manifest" ||
      args[4] !== "--signature" || args[6] !== "--trusted-key" || args[8] !== "--stage-dir") {
    throw new Error("Usage: stage-verified-artifact --artifact FILE --manifest FILE --signature FILE --trusted-key PINNED_KEY --stage-dir NEW_DIRECTORY");
  }
  const result = await stageVerifiedArtifact({ artifact: args[1], manifest: args[3], signature: args[5],
    trustedKey: args[7], stageDir: args[9] });
  console.log(`Staged verified release ${result.version} (${result.commit}), SHA-256 ${result.sha256}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Release staging failed: ${error.message}`);
    process.exitCode = 1;
  });
}

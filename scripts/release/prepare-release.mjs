#!/usr/bin/env node
import { mkdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVerifiedArtifact } from "./extract-verified-artifact.mjs";
import { loadPinnedReleaseKey, DEFAULT_TRUST_DIR } from "./pin-release-key.mjs";
import { stageVerifiedArtifact } from "./stage-verified-artifact.mjs";
import { verifyArtifact } from "./verify-artifact.mjs";

export async function prepareRelease({ artifact, manifest, signature, workspace, trustDir = DEFAULT_TRUST_DIR }) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to prepare a release");
  if (!path.isAbsolute(workspace || "")) throw new Error("A new absolute private workspace is required");
  const target = path.resolve(workspace);
  const parent = path.dirname(target);
  if ((await realpath(parent)) !== parent) throw new Error("Release workspace parent cannot contain symlinks");
  const parentInfo = await stat(parent);
  if (!parentInfo.isDirectory() || parentInfo.uid !== 0 || (parentInfo.mode & 0o022) !== 0) {
    throw new Error("Release workspace parent must be root-owned and not writable by other users");
  }
  const { keyFile, fingerprint } = await loadPinnedReleaseKey({ trustDir });
  // No workspace is created until the candidate passes its pinned-key check.
  await verifyArtifact({ artifact, manifest, signature, trustedKey: keyFile });
  await mkdir(target, { mode: 0o700 });
  try {
    const staged = await stageVerifiedArtifact({ artifact, manifest, signature, trustedKey: keyFile,
      stageDir: path.join(target, "staged") });
    const extracted = await extractVerifiedArtifact({ ...staged, outputDir: path.join(target, "extracted") });
    if (staged.commit !== extracted.commit || staged.sha256 !== extracted.sha256) {
      throw new Error("Staged and extracted release identities differ");
    }
    return { version: extracted.version, commit: extracted.commit, sha256: extracted.sha256,
      keyFingerprint: fingerprint, directory: extracted.directory };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

async function main(args) {
  if (args.length !== 8 || args[0] !== "--artifact" || args[2] !== "--manifest" ||
      args[4] !== "--signature" || args[6] !== "--workspace") {
    throw new Error("Usage: prepare-release --artifact FILE --manifest FILE --signature FILE --workspace NEW_PRIVATE_DIRECTORY");
  }
  const result = await prepareRelease({ artifact: args[1], manifest: args[3], signature: args[5], workspace: args[7] });
  console.log(`Prepared verified release ${result.version} (${result.commit}); archive SHA-256 ${result.sha256}; pinned key SHA-256 ${result.keyFingerprint}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Release preparation failed (${error.code || "validation"})`);
    process.exitCode = 1;
  });
}

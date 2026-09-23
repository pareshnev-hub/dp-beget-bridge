#!/usr/bin/env node
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createPrivateKey, sign } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkArtifact, parseManifest, readRegularFile } from "./verify-artifact.mjs";

export async function signManifest({ artifact, manifest, privateKey, signature }) {
  if (![artifact, manifest, privateKey, signature].every(value => typeof value === "string" && value.length > 0)) {
    throw new Error("Artifact, manifest, private key and signature paths are required");
  }
  if (new Set([artifact, manifest, privateKey, signature].map(value => path.resolve(value))).size !== 4) {
    throw new Error("Release inputs must be separate files");
  }
  const manifestBytes = await readRegularFile(manifest, 16 * 1024);
  const record = parseManifest(manifestBytes);
  await checkArtifact(artifact, record);

  const keyFile = await open(privateKey, constants.O_RDONLY | constants.O_NOFOLLOW);
  let keyBytes;
  try {
    const info = await keyFile.stat();
    if (!info.isFile() || info.size > 8 * 1024 || (info.mode & 0o077) !== 0) {
      throw new Error("Release signing key must be a private regular file (mode 0600)");
    }
    keyBytes = await keyFile.readFile();
  } finally { await keyFile.close(); }
  let key;
  try { key = createPrivateKey(keyBytes); } catch { throw new Error("Invalid release signing key"); }
  keyBytes.fill(0);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Release signing key must be Ed25519");
  const detached = sign(null, manifestBytes, key).toString("base64") + "\n";
  const output = await open(signature, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await output.writeFile(detached); } finally { await output.close(); }
  return { version: record.version, commit: record.commit };
}

async function main(args) {
  if (args.length !== 8 || args[0] !== "--artifact" || args[2] !== "--manifest" ||
      args[4] !== "--private-key" || args[6] !== "--signature") {
    throw new Error("Usage: sign-manifest --artifact FILE --manifest FILE --private-key FILE --signature NEW_FILE");
  }
  const result = await signManifest({ artifact: args[1], manifest: args[3], privateKey: args[5], signature: args[7] });
  console.log(`Signed release candidate ${result.version} (${result.commit})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Release signing failed: ${error.message}`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FORMAT = "dp-beget-bridge-release-v1";

export async function readRegularFile(filename, maxBytes) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Invalid release metadata file");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function exactlyKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function parseManifest(bytes) {
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Invalid release manifest"); }
  if (!exactlyKeys(manifest, ["format", "version", "commit", "artifact"]) ||
      manifest.format !== FORMAT ||
      typeof manifest.version !== "string" ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version) ||
      typeof manifest.commit !== "string" || !/^[0-9a-f]{40}$/.test(manifest.commit) ||
      !exactlyKeys(manifest.artifact, ["name", "size", "sha256"]) ||
      typeof manifest.artifact.name !== "string" ||
      !/^dp-beget-bridge-[0-9A-Za-z.-]+\.tar\.gz$/.test(manifest.artifact.name) ||
      manifest.artifact.name !== `dp-beget-bridge-${manifest.version}.tar.gz` ||
      !Number.isSafeInteger(manifest.artifact.size) || manifest.artifact.size < 1 ||
      typeof manifest.artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.artifact.sha256)) {
    throw new Error("Invalid release manifest");
  }
  return manifest;
}

export async function verifyArtifact({ artifact, manifest, signature, trustedKey }) {
  if (![artifact, manifest, signature, trustedKey].every(value => typeof value === "string" && value.length > 0)) {
    throw new Error("Artifact, manifest, signature and trusted key are required");
  }
  const paths = [artifact, manifest, signature, trustedKey].map(value => path.resolve(value));
  if (new Set(paths).size !== paths.length) throw new Error("Release inputs must be separate files");

  const [manifestBytes, signatureBytes, trustedKeyBytes] = await Promise.all([
    readRegularFile(manifest, 16 * 1024),
    readRegularFile(signature, 4 * 1024),
    readRegularFile(trustedKey, 8 * 1024)
  ]);
  const record = parseManifest(manifestBytes);
  if (path.basename(artifact) !== record.artifact.name) throw new Error("Artifact name mismatch");

  const encoded = signatureBytes.toString("ascii").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("Invalid release signature encoding");
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== 64 || decoded.toString("base64") !== encoded) {
    throw new Error("Invalid release signature encoding");
  }
  let key;
  try { key = createPublicKey(trustedKeyBytes); } catch { throw new Error("Invalid trusted release key"); }
  if (key.asymmetricKeyType !== "ed25519" || !verifySignature(null, manifestBytes, key, decoded)) {
    throw new Error("Release signature verification failed");
  }

  await checkArtifact(artifact, record);
  return { version: record.version, commit: record.commit, sha256: record.artifact.sha256, size: record.artifact.size };
}

export async function checkArtifact(artifact, record) {
  if (path.basename(artifact) !== record.artifact.name) throw new Error("Artifact name mismatch");
  const handle = await open(artifact, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== record.artifact.size) throw new Error("Artifact size mismatch");
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    if (digest.digest("hex") !== record.artifact.sha256) throw new Error("Artifact checksum mismatch");
  } finally {
    await handle.close();
  }
}

async function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    if (!args[i]?.startsWith("--") || !["artifact", "manifest", "signature", "trustedKey"].includes(key) ||
        !args[i + 1] || Object.hasOwn(options, key)) {
      throw new Error("Usage: verify-artifact --artifact FILE --manifest FILE --signature FILE --trustedKey FILE");
    }
    options[key] = args[i + 1];
  }
  const result = await verifyArtifact(options);
  console.log(`Verified release ${result.version} (${result.commit}), SHA-256 ${result.sha256}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Release verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}

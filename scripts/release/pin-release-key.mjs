#!/usr/bin/env node
import { createHash, createPublicKey } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readRegularFile } from "./verify-artifact.mjs";

export const DEFAULT_TRUST_DIR = "/etc/dp-beget-bridge/release-trust";
const KEY_NAME = "ed25519-public.pem";

export function inspectReleasePublicKey(bytes, expectedSha256) {
  if (!/^[0-9a-f]{64}$/.test(expectedSha256 || "")) throw new Error("An independent SHA-256 key fingerprint is required");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) throw new Error("Release key fingerprint does not match the independent pin");
  let key;
  try { key = createPublicKey(bytes); } catch { throw new Error("Invalid release public key"); }
  if (key.asymmetricKeyType !== "ed25519" || key.type !== "public" ||
      key.export({ format: "pem", type: "spki" }).toString() !== bytes.toString()) {
    throw new Error("Release key must be one canonical Ed25519 SPKI PEM public key");
  }
  return actual;
}

async function assertRootPath(directory) {
  const resolved = path.resolve(directory);
  if (!path.isAbsolute(directory) || (await realpath(resolved)) !== resolved) {
    throw new Error("Trust directory path must be absolute and have no symlink components");
  }
  const info = await stat(resolved);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
    throw new Error("Trust directory must be root-owned and not writable by other users");
  }
}

export async function pinReleaseKey({ source, expectedSha256, trustDir = DEFAULT_TRUST_DIR }) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to pin the release trust key");
  if (!path.isAbsolute(source || "") || !path.isAbsolute(trustDir || "")) {
    throw new Error("Absolute source and trust directory paths are required");
  }
  const directory = path.resolve(trustDir);
  await assertRootPath(path.dirname(directory));
  const bytes = await readRegularFile(source, 8 * 1024);
  const fingerprint = inspectReleasePublicKey(bytes, expectedSha256);
  await mkdir(directory, { mode: 0o755 });
  try {
    await assertRootPath(directory);
    const keyFile = path.join(directory, KEY_NAME);
    const handle = await open(keyFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    const dirHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    return { keyFile, fingerprint };
  } catch (error) {
    // A successful pin is immutable. On failure, leave an incomplete directory
    // visible for manual inspection rather than silently replacing a key.
    await rmdir(directory).catch(() => {});
    throw error;
  }
}

export async function loadPinnedReleaseKey({ trustDir = DEFAULT_TRUST_DIR } = {}) {
  const directory = path.resolve(trustDir);
  if (!path.isAbsolute(trustDir)) throw new Error("Absolute trust directory path is required");
  await assertRootPath(path.dirname(directory));
  await assertRootPath(directory);
  const keyFile = path.join(directory, KEY_NAME);
  const info = await lstat(keyFile);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o022) !== 0) {
    throw new Error("Pinned release key must be a root-owned regular file without writable sharing");
  }
  const bytes = await readRegularFile(keyFile, 8 * 1024);
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  inspectReleasePublicKey(bytes, fingerprint);
  return { keyFile, fingerprint };
}

async function main(args) {
  if (args.length !== 4 || args[0] !== "--source" || args[2] !== "--sha256") {
    throw new Error("Usage: pin-release-key --source INDEPENDENT_PUBLIC_KEY_PEM --sha256 INDEPENDENT_64_HEX_SHA256");
  }
  const result = await pinReleaseKey({ source: args[1], expectedSha256: args[3] });
  console.log(`Pinned release key SHA-256 ${result.fingerprint}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Release key pinning failed (${error.code || "validation"})`);
    process.exitCode = 1;
  });
}

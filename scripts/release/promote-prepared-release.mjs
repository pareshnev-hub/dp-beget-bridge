#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { inspectTar } from "./extract-verified-artifact.mjs";
import { inspectInstalledTree } from "./install-quarantined-dependencies.mjs";
import { DEFAULT_TRUST_DIR, loadPinnedReleaseKey } from "./pin-release-key.mjs";
import { parseManifest, readRegularFile, verifyArtifact } from "./verify-artifact.mjs";

const MAX_COMPRESSED = 64 * 1024 * 1024;
const MAX_EXPANDED = 256 * 1024 * 1024;

async function assertRootDirectory(directory, privateMode = false) {
  if (!path.isAbsolute(directory || "") || (await realpath(directory)) !== directory) {
    throw new Error("Release directory must be absolute and symlink-free");
  }
  const info = await stat(directory);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & (privateMode ? 0o077 : 0o022)) !== 0) {
    throw new Error("Release directory must be root-owned with safe permissions");
  }
}

async function checkAndMakeReadable(source, entries, rootName) {
  const expected = new Map(entries.map(entry => [entry.relative, entry]));
  async function walk(directory, relative) {
    for (const name of await readdir(directory)) {
      if (relative === rootName && name === "node_modules") continue;
      const item = `${relative}/${name}`;
      const record = expected.get(item);
      if (!record) throw new Error("Prepared release contains an unrecorded source entry");
      const filename = path.join(directory, name);
      const info = await lstat(filename);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1) ||
          (record.directory ? !info.isDirectory() : !info.isFile())) {
        throw new Error("Prepared release source entry changed type");
      }
      if (record.directory) await walk(filename, item);
      else {
        if (info.size !== record.content.length) throw new Error("Prepared release source differs from signed archive");
        const bytes = await readRegularFile(filename, Math.max(1, record.content.length));
        if (!bytes.equals(record.content)) throw new Error("Prepared release source differs from signed archive");
      }
      expected.delete(item);
    }
  }
  await walk(source, rootName);
  expected.delete(rootName);
  if (expected.size) throw new Error("Prepared release is missing signed source entries");
  // The source tree is still inside a private workspace. The service-readable
  // modes become observable only after its atomic move into releases/.
  async function makeReadable(directory) {
    for (const name of await readdir(directory)) {
      const filename = path.join(directory, name);
      const info = await lstat(filename);
      if (info.isDirectory()) { await makeReadable(filename); await chmod(filename, 0o755); }
      else if (info.isFile()) await chmod(filename, 0o644);
      else if (!info.isSymbolicLink()) throw new Error("Prepared release contains a special entry");
    }
  }
  await makeReadable(source);
  await chmod(source, 0o755);
}

export async function promotePreparedRelease({ workspace, releaseRoot, trustDir = DEFAULT_TRUST_DIR }) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to promote a release");
  await assertRootDirectory(workspace, true);
  await assertRootDirectory(releaseRoot);
  const releases = path.join(releaseRoot, "releases");
  await assertRootDirectory(releases);
  const { keyFile } = await loadPinnedReleaseKey({ trustDir });
  const manifest = path.join(workspace, "staged", "manifest.json");
  const signature = path.join(workspace, "staged", "manifest.sig");
  const record = parseManifest(await readRegularFile(manifest, 16 * 1024));
  const artifact = path.join(workspace, "staged", record.artifact.name);
  const identity = await verifyArtifact({ artifact, manifest, signature, trustedKey: keyFile });
  if (identity.size > MAX_COMPRESSED) throw new Error("Signed archive exceeds the release ceiling");
  const compressed = await readRegularFile(artifact, MAX_COMPRESSED);
  // The signed digest is checked again on the exact bytes parsed here.
  if (compressed.length !== identity.size ||
      createHash("sha256").update(compressed).digest("hex") !== identity.sha256) {
    throw new Error("Signed archive changed before promotion");
  }
  const entries = inspectTar(gunzipSync(compressed, { maxOutputLength: MAX_EXPANDED }),
    identity.version, identity.commit);
  const rootName = `dp-beget-bridge-${identity.version}`;
  const source = path.join(workspace, "extracted", rootName);
  await assertRootDirectory(source, true);
  const pkg = JSON.parse(await readRegularFile(path.join(source, "package.json"), 16 * 1024));
  if (pkg.name !== "dp-beget-bridge" || pkg.version !== identity.version) {
    throw new Error("Prepared package version differs from the signed release");
  }
  await inspectInstalledTree(source, Object.keys(pkg.dependencies || {}).length > 0);
  const versionDir = `${identity.version}-${identity.commit}`;
  const destination = path.join(releases, versionDir);
  const lock = path.join(releaseRoot, ".promotion.lock");
  await mkdir(lock, { mode: 0o700 });
  try {
    try { await lstat(destination); throw new Error("Release version already exists"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await checkAndMakeReadable(source, entries, rootName);
    await rename(source, destination); // Refuse EXDEV; never copy an unverified tree into the live root.
    const handle = await open(releases, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
    return { versionDir, directory: destination, sha256: identity.sha256 };
  } finally { await rmdir(lock); }
}

async function main(args) {
  if (args.length !== 4 || args[0] !== "--workspace" || args[2] !== "--release-root") {
    throw new Error("Usage: promote-prepared-release --workspace PRIVATE_PREPARED_DIRECTORY --release-root ROOT_OWNED_VERSION_ROOT");
  }
  const result = await promotePreparedRelease({ workspace: args[1], releaseRoot: args[3] });
  console.log(`Promoted inert release directory ${result.versionDir}; signed archive SHA-256 ${result.sha256}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Release promotion failed (${error.code || "validation"})`);
    process.exitCode = 1;
  });
}

import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { inspectTar } from "./extract-verified-artifact.mjs";
import { inspectInstalledTree } from "./install-quarantined-dependencies.mjs";
import { loadPinnedReleaseKey } from "./pin-release-key.mjs";
import { parseManifest, readRegularFile, verifyArtifact } from "./verify-artifact.mjs";
import { verifyCleanInstallManifest } from "./clean-install-manifest.mjs";

// Verify the inert destination after the source has moved. The workspace
// still holds the signed archive and candidate manifest, but not its extracted
// source. No version pointer or systemd state is changed here.
export async function inspectPromotedCleanRelease({ journal, trustDir,
  verify = verifyCleanInstallManifest } = {}) {
  if (process.getuid?.() !== 0 || !journal) {
    throw new Error("Root and clean-install journal are required to inspect promotion");
  }
  const candidate = await verify({ workspace: journal.workspace,
    manifestSha256: journal.manifestSha256, trustDir });
  if (candidate.artifactSha256 !== journal.artifactSha256 ||
      candidate.version !== journal.version || candidate.commit !== journal.commit) {
    throw new Error("Promoted release candidate changed");
  }
  const { keyFile } = await loadPinnedReleaseKey({ trustDir });
  const staged = path.join(journal.workspace, "staged");
  const manifest = path.join(staged, "manifest.json");
  const signed = parseManifest(await readRegularFile(manifest, 16 * 1024));
  const identity = await verifyArtifact({ artifact: path.join(staged, signed.artifact.name),
    manifest, signature: path.join(staged, "manifest.sig"), trustedKey: keyFile });
  if (identity.sha256 !== journal.artifactSha256 || identity.size > 64 * 1024 * 1024) {
    throw new Error("Promoted release signed identity changed");
  }
  const compressed = await readRegularFile(path.join(staged, signed.artifact.name), 64 * 1024 * 1024);
  if (compressed.length !== identity.size ||
      createHash("sha256").update(compressed).digest("hex") !== identity.sha256) {
    throw new Error("Promoted release archive changed");
  }
  const entries = inspectTar(gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 }),
    identity.version, identity.commit);
  const rootName = `dp-beget-bridge-${journal.version}`;
  const versionDir = `${journal.version}-${journal.commit}`;
  const releases = path.join(journal.releaseRoot, "releases");
  const destination = path.join(releases, versionDir);
  for (const directory of [journal.releaseRoot, releases, destination]) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.uid !== 0 || info.gid !== 0 ||
        (info.mode & 0o777) !== 0o755 || await realpath(directory) !== directory) {
      throw new Error("Promoted release directory is untrusted");
    }
  }
  if (JSON.stringify((await readdir(journal.releaseRoot)).sort()) !== '["releases"]' ||
      JSON.stringify((await readdir(releases)).sort()) !== JSON.stringify([versionDir])) {
    throw new Error("Promoted release root has unexpected contents");
  }
  const expected = new Map(entries.map(entry => [entry.relative, entry]));
  async function walk(directory, relative) {
    for (const name of await readdir(directory)) {
      if (relative === rootName && name === "node_modules") continue;
      const key = `${relative}/${name}`;
      const signedEntry = expected.get(key);
      if (!signedEntry) throw new Error("Promoted release has an unsigned source entry");
      const filename = path.join(directory, name);
      const info = await lstat(filename);
      if (info.uid !== 0 || info.gid !== 0 ||
          (signedEntry.directory ? !info.isDirectory() || (info.mode & 0o777) !== 0o755
            : !info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o644)) {
        throw new Error("Promoted release source permissions or type changed");
      }
      if (signedEntry.directory) await walk(filename, key);
      else {
        const actual = await readRegularFile(filename, Math.max(1, signedEntry.content.length));
        if (actual.length !== info.size || !actual.equals(signedEntry.content)) {
          throw new Error("Promoted release source differs from signed archive");
        }
      }
      expected.delete(key);
    }
  }
  await walk(destination, rootName);
  expected.delete(rootName);
  if (expected.size) throw new Error("Promoted release is missing signed source entries");
  const pkg = JSON.parse(await readRegularFile(path.join(destination, "package.json"), 16 * 1024));
  if (pkg.name !== "dp-beget-bridge" || pkg.version !== journal.version) {
    throw new Error("Promoted release package identity changed");
  }
  await inspectInstalledTree(destination, Object.keys(pkg.dependencies || {}).length > 0);
  try { await lstat(path.join(journal.workspace, "extracted", rootName));
    throw new Error("Promoted release source still exists in workspace"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await verify({ workspace: journal.workspace,
    manifestSha256: journal.manifestSha256, trustDir });
  return { release: "signed-inert", versionDir, sha256: identity.sha256 };
}

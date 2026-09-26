import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_TRUST_DIR, loadPinnedReleaseKey } from "./pin-release-key.mjs";
import { parseManifest, readRegularFile, verifyArtifact } from "./verify-artifact.mjs";

const SHA = /^[0-9a-f]{64}$/;
const UNIT_FILES = ["dp-beget-agent.service", "dp-beget-mcp.service", "dp-beget-session-host.service"];
const CONFIG_FILES = ["agent.env", "mcp.env", "session-host.env"];
const EXPECTED = [
  ...CONFIG_FILES.map(name => `config/${name}`),
  ...UNIT_FILES.map(name => `units/${name}`)
].sort();
const FORMAT = "dp-beget-clean-install-candidate-v1";

async function privateDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) ||
      path.normalize(directory) !== directory) throw new Error("Invalid clean-install directory");
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o077) !== 0 ||
      (await realpath(directory)) !== directory) throw new Error("Untrusted clean-install directory");
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function signedIdentity(workspace, trustDir) {
  const { keyFile } = await loadPinnedReleaseKey({ trustDir });
  const staged = path.join(workspace, "staged");
  await privateDirectory(staged);
  const manifest = path.join(staged, "manifest.json");
  const signed = parseManifest(await readRegularFile(manifest, 16 * 1024));
  const signature = path.join(staged, "manifest.sig");
  const artifact = path.join(staged, signed.artifact.name);
  return verifyArtifact({ artifact, manifest, signature, trustedKey: keyFile });
}

async function stagedFiles(workspace, allowManifest) {
  const root = path.join(workspace, "clean-install");
  await privateDirectory(root);
  const rootNames = await readdir(root);
  if (JSON.stringify(rootNames.sort()) !== JSON.stringify(
    (allowManifest ? ["config", "units", "candidate-manifest.json"] : ["config", "units"]).sort())) {
    throw new Error("Unexpected clean-install staging entry");
  }
  const records = [];
  for (const [directory, names] of [["config", CONFIG_FILES], ["units", UNIT_FILES]]) {
    const parent = path.join(root, directory);
    await privateDirectory(parent);
    if (JSON.stringify((await readdir(parent)).sort()) !== JSON.stringify(names)) {
      throw new Error("Clean-install staging inventory changed");
    }
    for (const name of names) {
      const filename = path.join(parent, name);
      const info = await lstat(filename);
      if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 ||
          (info.mode & 0o777) !== 0o600 || info.size < 1 || info.size > 16 * 1024) {
        throw new Error("Unsafe clean-install staged file");
      }
      const bytes = await readRegularFile(filename, 16 * 1024);
      if (bytes.length !== info.size) throw new Error("Clean-install staged file changed during read");
      records.push({ path: `${directory}/${name}`, size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  }
  return records.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function validate(record) {
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      Object.keys(record).sort().join(",") !== "artifactSha256,commit,files,format,version" ||
      record.format !== FORMAT || !SHA.test(record.artifactSha256) ||
      !/^[0-9a-f]{40}$/.test(record.commit || "") ||
      typeof record.version !== "string" || !Array.isArray(record.files) ||
      record.files.length !== EXPECTED.length ||
      record.files.some((file, index) => !file ||
        Object.keys(file).sort().join(",") !== "path,sha256,size" ||
        file.path !== EXPECTED[index] || !SHA.test(file.sha256) ||
        !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 16 * 1024)) {
    throw new Error("Invalid clean-install candidate manifest");
  }
  return record;
}

export async function writeCleanInstallManifest({ workspace, artifactSha256,
  trustDir = DEFAULT_TRUST_DIR } = {}) {
  if (process.getuid?.() !== 0 || !SHA.test(artifactSha256 || "")) {
    throw new Error("Root and signed candidate digest are required");
  }
  await privateDirectory(workspace);
  const identity = await signedIdentity(workspace, trustDir);
  if (identity.sha256 !== artifactSha256) throw new Error("Prepared archive changed before manifest binding");
  const files = await stagedFiles(workspace, false);
  const record = validate({ format: FORMAT, version: identity.version, commit: identity.commit,
    artifactSha256, files });
  const bytes = Buffer.from(JSON.stringify(record) + "\n");
  const filename = path.join(workspace, "clean-install", "candidate-manifest.json");
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(path.dirname(filename));
  return { sha256: createHash("sha256").update(bytes).digest("hex"),
    artifactSha256, files: EXPECTED.length };
}

// Before a real install, recheck the separately bound manifest SHA and every
// private file. The eventual copying transaction must still check bytes again.
export async function verifyCleanInstallManifest({ workspace, manifestSha256,
  trustDir = DEFAULT_TRUST_DIR } = {}) {
  if (process.getuid?.() !== 0 || !SHA.test(manifestSha256 || "")) {
    throw new Error("Root and bound candidate manifest digest are required");
  }
  await privateDirectory(workspace);
  const filename = path.join(workspace, "clean-install", "candidate-manifest.json");
  const info = await lstat(filename);
  if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) {
    throw new Error("Untrusted clean-install candidate manifest");
  }
  const bytes = await readRegularFile(filename, 4096);
  if (createHash("sha256").update(bytes).digest("hex") !== manifestSha256) {
    throw new Error("Clean-install candidate manifest changed");
  }
  const record = validate(JSON.parse(bytes.toString("utf8")));
  const identity = await signedIdentity(workspace, trustDir);
  if (identity.sha256 !== record.artifactSha256 || identity.version !== record.version ||
      identity.commit !== record.commit ||
      JSON.stringify(await stagedFiles(workspace, true)) !== JSON.stringify(record.files)) {
    throw new Error("Clean-install candidate files changed after preparation");
  }
  return { version: identity.version, commit: identity.commit,
    artifactSha256: identity.sha256, manifestSha256, files: EXPECTED.length };
}

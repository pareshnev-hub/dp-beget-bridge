import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const MAIN_ROOT = "/opt/dp-beget-bridge";
const OAUTH_ROOT = "/opt/dp-beget-bridge-dp012-dcr";
const FILES = Object.freeze([
  { root: MAIN_ROOT, name: "agent", relative: "apps/agent/src/server.js",
    before: "bdc299a6bea00950fe42a24ce5c1fd08305142f13f0e4485a1e67beb6b4aeab7",
    after: "4b46578b5f3cc42ca9186a1132af78ee6987f12f96a235d0cde8a59785887ae5" },
  { root: MAIN_ROOT, name: "base-mcp", relative: "apps/mcp/src/server.js",
    before: "17a201dd7c01c6c243f816fe32755b16cad22dfcfaf191dc6273366a50c05b85",
    after: "8d2b5c3de3073e61db8634011ffb4a32577bc188d18be30aeee5f40f1d3025e4" },
  { root: MAIN_ROOT, name: "session-host", relative: "apps/session-host/src/server.js",
    before: "942934eda39a8c0ad122cefb455f3313ba6c68163458e31600dc9d3b2b184194",
    after: "8afd690b6f011e60526f2b8f01fe58e569e2303f79433c3b38f57926f6dbcedc" },
  { root: OAUTH_ROOT, name: "oauth-mcp", relative: "apps/mcp/src/server.js",
    before: "17a201dd7c01c6c243f816fe32755b16cad22dfcfaf191dc6273366a50c05b85",
    after: "8d2b5c3de3073e61db8634011ffb4a32577bc188d18be30aeee5f40f1d3025e4" }
]);

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const absolute = value => typeof value === "string" && path.isAbsolute(value) &&
  path.normalize(value) === value;
const overlaps = (a, b) => a === b || a.startsWith(`${b}${path.sep}`) ||
  b.startsWith(`${a}${path.sep}`);

async function trustedDirectory(directory, { candidate = false } = {}) {
  const info = await stat(directory);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o002) !== 0 ||
      ((info.mode & 0o020) !== 0 && (!candidate || info.gid !== 0)) ||
      await realpath(directory) !== directory) throw new Error("Untrusted hotfix directory");
}

async function pinnedFile(filename, digest, expectedModes) {
  const info = await lstat(filename);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || info.gid !== 0 ||
      !expectedModes.includes(info.mode & 0o7777) || info.size > 512 * 1024 ||
      await realpath(filename) !== filename) throw new Error("Untrusted R0003 source file");
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try { bytes = await handle.readFile(); } finally { await handle.close(); }
  if (sha256(bytes) !== digest || bytes.length !== info.size) {
    throw new Error("Live R0003 source does not match the pinned hotfix base");
  }
  return { bytes, mode: info.mode & 0o777 };
}

async function syncFile(filename) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// Inert, root-only preparation of original bytes and exact candidate bytes.
// No systemd action, code replacement, or network access. The candidate root
// must contain the four files from reviewed hotfix commit 5fd8d6938e4123bf57d87fca059e16b58780ed0c.
export async function stageLegacyCounterHotfix({ outputDir, candidateRoot,
  files = FILES } = {}) {
  if (process.getuid?.() !== 0 || !absolute(outputDir) || !absolute(candidateRoot) ||
      files.length !== 4 || new Set(files.map(item => item.name)).size !== 4 ||
      files.some(item => !absolute(item.root) || !/^[a-z-]+$/.test(item.name) ||
        !/^[a-z0-9/-]+\.js$/.test(item.relative) || !/^[0-9a-f]{64}$/.test(item.before) ||
        !/^[0-9a-f]{64}$/.test(item.after)) ||
      [candidateRoot, ...files.map(item => item.root)].some(root => overlaps(root, outputDir))) {
    throw new Error("Root and an isolated private hotfix staging directory are required");
  }
  const parent = path.dirname(outputDir);
  await trustedDirectory(parent);
  await trustedDirectory(candidateRoot, { candidate: true });
  for (const root of new Set(files.map(item => item.root))) await trustedDirectory(root);
  const records = [];
  for (const item of files) {
    const source = path.join(item.root, item.relative);
    const candidate = path.join(candidateRoot, item.relative);
    // All four observed live files are root:root 0664. Git checkout modes
    // depend on root's umask; accept only root:root 0644 or 0664 candidates.
    // A later installer must recheck before any live replacement.
    const original = await pinnedFile(source, item.before, [0o664]);
    const updated = await pinnedFile(candidate, item.after, [0o644, 0o664]);
    records.push({ name: item.name, source, before: item.before, after: item.after,
      mode: original.mode, original: original.bytes, updated: updated.bytes });
  }
  await mkdir(outputDir, { mode: 0o700 });
  try {
    for (const record of records) {
      for (const [suffix, bytes] of [["before", record.original], ["after", record.updated]]) {
        const filename = path.join(outputDir, `${record.name}.${suffix}.js`);
        await writeFile(filename, bytes, { flag: "wx", mode: 0o600 });
        await syncFile(filename);
      }
    }
    const manifest = { format: "dp-r0003-counter-hotfix-v1",
      files: records.map(({ name, source, before, after, mode }) =>
        ({ name, source, before, after, mode })) };
    const manifestPath = path.join(outputDir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest) + "\n", { flag: "wx", mode: 0o600 });
    await syncFile(manifestPath);
    await syncDirectory(outputDir);
    await syncDirectory(parent);
    return { directory: outputDir, manifestSha256: sha256(await readFile(manifestPath)), files: 4 };
  } catch (error) {
    await rm(outputDir, { recursive: true, force: true });
    throw error;
  }
}

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { inspectRecoveryDestinations } from "./inspect-recovery-destinations.mjs";
import { readMigrationJournal, verifyJournalUnitBackup } from "./migration-journal.mjs";
import { assertPreExposureRecoveryBoundary } from "./stage-pre-exposure-recovery.mjs";
import { verifyJournalStateBundle } from "./snapshot-legacy-state.mjs";
import { readRegularFile } from "./verify-artifact.mjs";

const SHA = /^[0-9a-f]{64}$/;
const safeName = name => typeof name === "string" && name.length > 0 &&
  name.split("/").every(part => /^[a-zA-Z0-9._-]+$/.test(part) && part !== "." && part !== "..");

async function privateRoot(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o077) !== 0 ||
      (await realpath(directory)) !== directory) throw new Error("Untrusted staged recovery directory");
}

async function manifest(filename, maxBytes, expectedSha) {
  const bytes = await readRegularFile(filename, maxBytes);
  if (!SHA.test(expectedSha || "") ||
      createHash("sha256").update(bytes).digest("hex") !== expectedSha) {
    throw new Error("Recovery manifest no longer matches its bound digest");
  }
  return JSON.parse(bytes.toString("utf8"));
}

async function fileMatches(filename, record) {
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || (await realpath(filename)) !== filename ||
        info.uid !== record.uid || info.gid !== record.gid ||
        (info.mode & 0o777) !== record.mode || info.size !== record.size || !SHA.test(record.sha256 || "")) {
      throw new Error(`Staged recovery file metadata changed: ${filename}`);
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    if (hash.digest("hex") !== record.sha256) throw new Error(`Staged recovery file changed: ${filename}`);
  } finally { await handle.close(); }
}

async function inventory(directory, prefix = "") {
  const paths = [];
  for (const entry of await readdir(directory)) {
    if (!safeName(entry)) throw new Error("Unsafe staged recovery entry");
    const relative = prefix ? `${prefix}/${entry}` : entry;
    const info = await lstat(path.join(directory, entry));
    if (!info.isDirectory() && !info.isFile()) throw new Error("Staged recovery contains a link or special file");
    paths.push(relative);
    if (info.isDirectory()) paths.push(...await inventory(path.join(directory, entry), relative));
    if (paths.length > 128) throw new Error("Staged recovery inventory limit exceeded");
  }
  return paths.sort();
}

async function recordedTree(directory, records, { unitFiles = false } = {}) {
  const expected = new Set();
  for (const item of records) {
    if (!safeName(item.path) || expected.has(item.path) ||
        !Number.isSafeInteger(item.uid) || item.uid < 0 ||
        !Number.isSafeInteger(item.gid) || item.gid < 0 ||
        !Number.isInteger(item.mode) || item.mode < 0 || item.mode > 0o777) {
      throw new Error("Invalid staged recovery file record");
    }
    expected.add(item.path);
    if (unitFiles) {
      if (item.uid !== 0 || item.type && item.type !== "file") throw new Error("Invalid staged original unit record");
      const parent = path.posix.dirname(item.path);
      if (parent !== ".") {
        expected.add(parent);
        await privateRoot(path.join(directory, parent));
      }
      await fileMatches(path.join(directory, item.path), item);
    } else if (item.type === "directory") {
      const info = await lstat(path.join(directory, item.path));
      if (!info.isDirectory() || (await realpath(path.join(directory, item.path))) !== path.join(directory, item.path) ||
          info.uid !== item.uid || info.gid !== item.gid || (info.mode & 0o777) !== item.mode) {
        throw new Error(`Staged configuration directory changed: ${item.path}`);
      }
    } else if (item.type === "file") await fileMatches(path.join(directory, item.path), item);
    else throw new Error("Invalid staged configuration record");
  }
  if (JSON.stringify(await inventory(directory)) !== JSON.stringify([...expected].sort())) {
    throw new Error("Staged recovery inventory changed");
  }
}

// Reopen a previously prepared pair without trusting its earlier in-memory
// result. This does not authorize live replacement or recover a missing pair.
export async function verifyStagedRecoveryPair({ journalPath, outputDir, ...boundary } = {}) {
  if (process.getuid?.() !== 0 || !path.isAbsolute(outputDir || "") ||
      path.normalize(outputDir) !== outputDir || typeof boundary.assertRouteExclusive !== "function") {
    throw new Error("Root, staged pair and exclusive route proof are required");
  }
  const journal = await readMigrationJournal(journalPath);
  if (!["snapshotted", "switched", "locally-healthy"].includes(journal.phase)) {
    throw new Error("Staged old state cannot be used after possible exposure");
  }
  const gate = { ...boundary, journalPath, transactionId: journal.transactionId, phase: journal.phase };
  await assertPreExposureRecoveryBoundary(gate);
  await verifyJournalUnitBackup(journal);
  await verifyJournalStateBundle(journal);
  await privateRoot(outputDir);
  const stateRoot = path.join(outputDir, "state");
  const unitRoot = path.join(outputDir, "units");
  await privateRoot(stateRoot);
  await privateRoot(unitRoot);
  if (JSON.stringify(await readdir(outputDir).then(items => items.sort())) !== JSON.stringify(["state", "units"]) ||
      JSON.stringify(await readdir(stateRoot).then(items => items.sort())) !== JSON.stringify(["config", "sqlite"])) {
    throw new Error("Unexpected staged recovery pair inventory");
  }
  const stateManifest = await manifest(path.join(journal.snapshotPath, "bundle-manifest.json"),
    16 * 1024, journal.snapshotSha256);
  const configManifest = await manifest(path.join(journal.snapshotPath, "config", "backup-manifest.json"),
    64 * 1024, stateManifest.manifestSha256?.config);
  const sqliteManifest = await manifest(path.join(journal.snapshotPath, "sqlite", "backup-manifest.json"),
    64 * 1024, stateManifest.manifestSha256?.sqlite);
  const unitManifest = await manifest(path.join(journal.unitBackup.path, "backup-manifest.json"),
    64 * 1024, journal.unitBackup.manifestSha256);
  if (!Array.isArray(configManifest.entries) || !Array.isArray(sqliteManifest.databases) ||
      !Array.isArray(unitManifest.files) || sqliteManifest.databases.length === 0 ||
      sqliteManifest.databases.length !== stateManifest.databases?.length ||
      sqliteManifest.databases.some((entry, index) => entry.name !== stateManifest.databases[index])) {
    throw new Error("Invalid staged recovery manifest inventory");
  }
  const configRoot = path.join(stateRoot, "config");
  const rootInfo = await lstat(configRoot);
  if (!rootInfo.isDirectory() || (await realpath(configRoot)) !== configRoot ||
      (rootInfo.mode & 0o777) !== configManifest.rootMode || rootInfo.uid !== 0) {
    throw new Error("Staged configuration root changed");
  }
  await recordedTree(configRoot, configManifest.entries);
  const sqliteRoot = path.join(stateRoot, "sqlite");
  await privateRoot(sqliteRoot);
  await recordedTree(sqliteRoot, sqliteManifest.databases.map(entry => ({ ...entry,
    path: `${entry.name}.sqlite`, type: "file" })));
  await recordedTree(unitRoot, unitManifest.files, { unitFiles: true });
  const destinations = await inspectRecoveryDestinations({ stagedDirectory: stateRoot,
    sources: stateManifest.sources, databases: stateManifest.databases });
  await assertPreExposureRecoveryBoundary(gate);
  await verifyJournalUnitBackup(journal);
  await verifyJournalStateBundle(journal);
  return { transactionId: journal.transactionId, phase: journal.phase, directory: outputDir,
    files: unitManifest.files.length, destinations };
}

#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { inspectTranscriptSegments, segmentPath, MAX_TRANSCRIPT_SEGMENTS } from "./transcript-segments.mjs";

const RESERVE_BYTES = 256n * 1024n * 1024n;
const MANIFEST = "archive.json";
const FORMAT = "dp-beget-terminal-archive-v1";
const SAFE_ID = /^[a-zA-Z0-9_-]{1,80}$/;

async function safeDirectory(directory, ownerRequired = false) {
  if (!path.isAbsolute(directory || "") || path.resolve(directory) !== directory ||
      await fs.realpath(directory) !== directory) throw new Error("Unsafe archive directory");
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || (info.mode & 0o022) !== 0 ||
      (ownerRequired && info.uid !== process.getuid?.())) {
    throw new Error("Unsafe archive directory");
  }
}

function readClosedSession(database, id) {
  if (database.prepare("PRAGMA user_version").get().user_version !== 2) {
    throw new Error("Unsupported session state schema");
  }
  const row = database.prepare(`SELECT id, closed_at, transcript_stream_id,
    transcript_epoch, transcript_earliest_offset, transcript_capture_state,
    transcript_gap_reason FROM sessions WHERE id = ?`).get(id);
  if (!row || !row.closed_at) throw new Error("Only a retained CLOSED terminal can be archived");
  return row;
}

async function capacity(directory, bytes) {
  const space = await fs.statfs(directory, { bigint: true });
  if (space.bavail < 0n || space.bsize < 1n ||
      space.bavail * space.bsize < RESERVE_BYTES + BigInt(bytes) + 4096n) {
    throw new Error("Insufficient free space to archive a transcript");
  }
}

function sameFile(before, after) {
  return before.isFile() && after.isFile() && before.nlink === 1n && after.nlink === 1n &&
    ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(key => before[key] === after[key]);
}

async function copyChecked(sourcePath, destinationPath, expectedSize) {
  const source = await fs.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(expectedSize)) {
      throw new Error("Transcript changed before archiving");
    }
    const destination = await fs.open(destinationPath, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const digest = createHash("sha256");
      let offset = 0;
      const chunk = Buffer.alloc(64 * 1024);
      while (offset < expectedSize) {
        const length = Math.min(chunk.length, expectedSize - offset);
        const { bytesRead } = await source.read(chunk, 0, length, offset);
        if (bytesRead !== length) throw new Error("Transcript changed during archiving");
        await destination.writeFile(chunk.subarray(0, bytesRead));
        digest.update(chunk.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if (!sameFile(before, await source.stat({ bigint: true }))) {
        throw new Error("Transcript changed during archiving");
      }
      await destination.sync();
      return digest.digest("hex");
    } finally { await destination.close(); }
  } finally { await source.close(); }
}

function validateArchive(record) {
  if (record?.format !== FORMAT || !SAFE_ID.test(record.sessionId || "") ||
      !Number.isSafeInteger(record.size) || record.size < 0 ||
      !Number.isSafeInteger(record.earliestOffset) || record.earliestOffset < 0 ||
      !Number.isSafeInteger(record.epoch) || record.epoch < 1 ||
      !Number.isSafeInteger(record.segmentBytes) || record.segmentBytes < 1 ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(record.streamId || "") ||
      typeof record.closedAt !== "string" ||
      !["ACTIVE", "DEGRADED", "STOPPED"].includes(record.captureState) ||
      !(record.gapReason === null || typeof record.gapReason === "string") ||
      !Array.isArray(record.files) || record.files.length < 1 ||
      record.files.length > MAX_TRANSCRIPT_SEGMENTS + 1) {
    throw new Error("Invalid terminal archive manifest");
  }
  let size = 0;
  for (let index = 0; index < record.files.length; index++) {
    const item = record.files[index];
    const expected = index ? path.basename(segmentPath("terminal.log", index)) : "terminal.log";
    if (item?.name !== expected || !Number.isSafeInteger(item.size) || item.size < 0 ||
        !/^[a-f0-9]{64}$/.test(item.sha256 || "")) {
      throw new Error("Invalid terminal archive inventory");
    }
    size += item.size;
  }
  if (size !== record.size || !Number.isSafeInteger(size) ||
      !Number.isSafeInteger(record.earliestOffset + size)) {
    throw new Error("Invalid terminal archive size");
  }
  return record;
}

export async function verifyTerminalArchive(directory) {
  await safeDirectory(directory);
  const manifest = await fs.open(path.join(directory, MANIFEST), constants.O_RDONLY | constants.O_NOFOLLOW);
  let record;
  try {
    const info = await manifest.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 256 * 1024) {
      throw new Error("Invalid terminal archive manifest");
    }
    record = validateArchive(JSON.parse(await manifest.readFile({ encoding: "utf8" })));
  } finally { await manifest.close(); }
  const present = (await fs.readdir(directory)).sort();
  if (present.join("\0") !== [MANIFEST, ...record.files.map(item => item.name)].sort().join("\0")) {
    throw new Error("Unexpected terminal archive files");
  }
  for (const item of record.files) {
    const name = path.join(directory, item.name);
    const file = await fs.open(name, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size !== item.size) {
        throw new Error("Terminal archive file changed");
      }
      const hash = createHash("sha256");
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      if (hash.digest("hex") !== item.sha256) throw new Error("Terminal archive checksum mismatch");
    } finally { await file.close(); }
  }
  return { sessionId: record.sessionId, size: record.size, files: record.files.length };
}

export async function archiveTerminal({ dataDir, sessionId, outputDir }) {
  if (!SAFE_ID.test(sessionId || "") || !path.isAbsolute(outputDir || "") ||
      path.resolve(outputDir) !== outputDir) throw new Error("Invalid terminal archive arguments");
  await safeDirectory(dataDir);
  await safeDirectory(path.dirname(outputDir), true);
  const sessionDirectory = path.join(dataDir, "sessions", sessionId);
  if (outputDir === sessionDirectory || outputDir.startsWith(`${sessionDirectory}${path.sep}`)) {
    throw new Error("Archive must be outside the retained terminal directory");
  }
  await safeDirectory(sessionDirectory);
  const databaseFile = await fs.lstat(path.join(dataDir, "state.sqlite"));
  if (!databaseFile.isFile() || databaseFile.nlink !== 1) {
    throw new Error("Unsafe session state database");
  }
  const database = new DatabaseSync(path.join(dataDir, "state.sqlite"), { openReadOnly: true });
  try {
    const session = readClosedSession(database, sessionId);
    const inventory = await inspectTranscriptSegments(path.join(sessionDirectory, "terminal.log"));
    if (inventory.missing) throw new Error("Retained terminal transcript is missing");
    await capacity(path.dirname(outputDir), inventory.size);
    await fs.mkdir(outputDir, { mode: 0o700 });
    try {
      const files = [];
      for (const entry of inventory.segments) {
        await capacity(outputDir, entry.size);
        const name = path.basename(entry.filename);
        const sha256 = await copyChecked(entry.filename, path.join(outputDir, name), entry.size);
        files.push({ name, size: entry.size, sha256 });
      }
      if (JSON.stringify(readClosedSession(database, sessionId)) !== JSON.stringify(session)) {
        throw new Error("Terminal state changed during archiving");
      }
      const after = await inspectTranscriptSegments(path.join(sessionDirectory, "terminal.log"));
      if (after.size !== inventory.size || after.segments.length !== inventory.segments.length ||
          after.segments.some((part, index) => part.size !== inventory.segments[index].size)) {
        throw new Error("Transcript changed during archiving");
      }
      const record = validateArchive({ format: FORMAT, sessionId, closedAt: session.closed_at,
        streamId: session.transcript_stream_id, epoch: session.transcript_epoch,
        earliestOffset: session.transcript_earliest_offset,
        captureState: session.transcript_capture_state, gapReason: session.transcript_gap_reason,
        segmentBytes: inventory.segmentBytes, size: inventory.size, files });
      const handle = await fs.open(path.join(outputDir, MANIFEST), "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(record) + "\n"); await handle.sync(); }
      finally { await handle.close(); }
      const folder = await fs.open(outputDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await folder.sync(); } finally { await folder.close(); }
      const report = await verifyTerminalArchive(outputDir);
      const parent = await fs.open(path.dirname(outputDir),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await parent.sync(); } finally { await parent.close(); }
      return report;
    } catch (error) {
      await fs.rm(outputDir, { recursive: true, force: true });
      throw error;
    }
  } finally { database.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let operation;
  if (args.length === 7 && args[0] === "archive" && args[1] === "--data-dir" &&
      args[3] === "--session-id" && args[5] === "--output-dir") {
    operation = archiveTerminal({ dataDir: args[2], sessionId: args[4], outputDir: args[6] });
  } else if (args.length === 3 && args[0] === "verify" && args[1] === "--archive-dir") {
    operation = verifyTerminalArchive(args[2]);
  } else {
    console.error("Usage: archive-terminal archive --data-dir DIR --session-id ID --output-dir NEW_DIR | verify --archive-dir DIR");
    process.exitCode = 64;
  }
  operation?.then(report => console.log(JSON.stringify(report))).catch(() => {
    console.error("Terminal archive check failed (validation)");
    process.exitCode = 1;
  });
}

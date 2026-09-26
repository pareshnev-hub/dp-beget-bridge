import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_TRANSCRIPT_SEGMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TRANSCRIPT_SEGMENTS = 1024;

export function segmentPath(outputPath, index) {
  if (!Number.isSafeInteger(index) || index < 1 || index > MAX_TRANSCRIPT_SEGMENTS) {
    throw new Error("Transcript segment index exceeds its limit");
  }
  return `${outputPath}.part-${String(index).padStart(6, "0")}`;
}

async function regularSize(filename) {
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.nlink !== 1 || !Number.isSafeInteger(info.size) || info.size < 0) {
    throw new Error("Unsafe transcript segment");
  }
  return info.size;
}

// The original terminal.log remains segment zero. New sessions append bounded
// numbered siblings; older single-file transcripts stay readable unchanged.
export async function inspectTranscriptSegments(outputPath,
  segmentBytes = DEFAULT_TRANSCRIPT_SEGMENT_BYTES) {
  if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 1) {
    throw new Error("Invalid transcript segment size");
  }
  const prefix = `${path.basename(outputPath)}.part-`;
  const entries = await fs.readdir(path.dirname(outputPath));
  const numbered = entries.filter(name => name.startsWith(prefix));
  if (numbered.length > MAX_TRANSCRIPT_SEGMENTS || numbered.some(name =>
    !/^\d{6}$/.test(name.slice(prefix.length)))) {
    throw new Error("Invalid transcript segment inventory");
  }
  let first;
  try { first = await regularSize(outputPath); }
  catch (error) {
    if (error.code !== "ENOENT" || numbered.length) throw error;
    return { segments: [], size: 0, missing: true };
  }
  if (numbered.length && first !== segmentBytes) {
    throw new Error("Transcript segments have an incomplete first file");
  }
  const segments = [{ filename: outputPath, start: 0, size: first }];
  let size = first;
  for (let index = 1; index <= numbered.length; index++) {
    const filename = segmentPath(outputPath, index);
    if (!numbered.includes(path.basename(filename))) {
      throw new Error("Transcript segment is missing");
    }
    const length = await regularSize(filename);
    if (length > segmentBytes || (index < numbered.length && length !== segmentBytes)) {
      throw new Error("Transcript segment length is invalid");
    }
    segments.push({ filename, start: size, size: length });
    size += length;
    if (!Number.isSafeInteger(size)) throw new Error("Transcript byte count exceeds safe limit");
  }
  return { segments, size, missing: false };
}

export async function readTranscriptBytes(segments, offset, length) {
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(length) || length < 0 || length > 256 * 1024 + 3) {
    throw new Error("Invalid transcript read bounds");
  }
  const result = Buffer.alloc(length);
  let copied = 0;
  for (const entry of segments) {
    if (copied === length) break;
    if (offset + copied >= entry.start + entry.size) continue;
    const start = offset + copied - entry.start;
    if (start < 0) throw new Error("Transcript segment has a gap");
    const count = Math.min(length - copied, entry.size - start);
    const file = await fs.open(entry.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size < entry.size) {
        throw new Error("Transcript changed during reading");
      }
      const { bytesRead } = await file.read(result, copied, count, start);
      if (bytesRead !== count) throw new Error("Transcript changed during reading");
      copied += count;
    } finally { await file.close(); }
  }
  if (copied !== length) throw new Error("Transcript read is incomplete");
  return result;
}

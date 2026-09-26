import fs, { constants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import { DEFAULT_TRANSCRIPT_SEGMENT_BYTES, inspectTranscriptSegments,
  segmentPath } from "./transcript-segments.mjs";

export const CAPTURE_STOP_SUFFIX = ".capture-stopped";

async function recordStorageStop(outputPath) {
  const marker = `${outputPath}${CAPTURE_STOP_SUFFIX}`;
  const temporary = `${marker}.${process.pid}.tmp`;
  const file = await fsp.open(temporary, "wx", 0o600);
  try { await file.writeFile("storage_reserve\n"); await file.sync(); }
  finally { await file.close(); }
  try {
    await fsp.rename(temporary, marker);
    const directory = await fsp.open(path.dirname(marker), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}

// Preserve free space even when nobody requests terminal output. The tmux
// terminal keeps running if capture stops; Session Host reads the marker later.
export async function captureTranscript({ outputPath, maximum, minimumFree = 0,
  segmentBytes = DEFAULT_TRANSCRIPT_SEGMENT_BYTES,
  input = process.stdin, inspectFilesystem = fsp.statfs,
  recordStop = recordStorageStop } = {}) {
  if (!outputPath || !Number.isSafeInteger(maximum) || maximum < 1 ||
      !Number.isSafeInteger(minimumFree) || minimumFree < 0 ||
      !Number.isSafeInteger(segmentBytes) || segmentBytes < 1) {
    throw new Error("Invalid transcript capture limits");
  }
  segmentBytes = Math.min(segmentBytes, maximum);
  const existing = await inspectTranscriptSegments(outputPath, segmentBytes);
  // An older unsplit transcript may exceed the new segment size. Continue it
  // under its original per-session ceiling instead of attempting a negative write.
  if (existing.segments.length === 1 && existing.size > segmentBytes) segmentBytes = maximum;
  let remaining = Math.max(0, maximum - existing.size);
  if (remaining === 0) return { stopped: "transcript_limit" };
  let output;
  let stopped = null;
  let index = Math.max(0, existing.segments.length - 1);
  let segmentSize = existing.segments.at(-1)?.size || 0;
  let newSegment = existing.segments.length === 0;
  try {
    outer: for await (const chunk of input) {
      let position = 0;
      while (position < chunk.length) {
        if (segmentSize === segmentBytes) {
          if (output) { output.end(); await finished(output); output = null; }
          index += 1;
          segmentPath(outputPath, index); // Fail before writing past the segment-count ceiling.
          segmentSize = 0;
          newSegment = true;
        }
        const portion = chunk.subarray(position, position +
          Math.min(chunk.length - position, remaining, segmentBytes - segmentSize));
        if (minimumFree > 0) {
          let sufficient = false;
          try {
            const space = await inspectFilesystem(path.dirname(outputPath), { bigint: true });
            sufficient = typeof space.bavail === "bigint" && typeof space.bsize === "bigint" &&
              space.bavail >= 0n && space.bsize > 0n &&
              space.bavail * space.bsize >= BigInt(minimumFree) + BigInt(portion.length) + 4096n;
          } catch { /* Missing capacity is a failed reserve check. */ }
          if (!sufficient) {
            await recordStop(outputPath);
            stopped = "storage_reserve";
            break outer;
          }
        }
        if (!output) {
          const filename = index === 0 ? outputPath : segmentPath(outputPath, index);
          const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW |
            (newSegment ? constants.O_CREAT | constants.O_EXCL : 0);
          output = fs.createWriteStream(filename, { flags, mode: 0o600 });
          newSegment = false;
        }
        if (!output.write(portion)) await once(output, "drain");
        position += portion.length;
        remaining -= portion.length;
        segmentSize += portion.length;
        if (remaining === 0) { stopped = "transcript_limit"; break outer; }
      }
    }
    if (output) { output.end(); await finished(output); }
    return { stopped };
  } catch (error) {
    output?.destroy();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [outputPath, rawMaximum, rawMinimumFree = "0",
    rawSegmentBytes = String(DEFAULT_TRANSCRIPT_SEGMENT_BYTES)] = process.argv.slice(2);
  if (process.argv.length > 6 || !outputPath ||
      !/^[1-9]\d*$/.test(rawMaximum || "") || !/^(0|[1-9]\d*)$/.test(rawMinimumFree) ||
      !/^[1-9]\d*$/.test(rawSegmentBytes)) {
    process.exitCode = 64;
  } else {
    captureTranscript({ outputPath, maximum: Number(rawMaximum),
      minimumFree: Number(rawMinimumFree), segmentBytes: Number(rawSegmentBytes) }).catch(() => {
      // Neither paths nor terminal output belong in operational logs.
      process.exitCode = 1;
    });
  }
}

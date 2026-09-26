import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { finished } from "node:stream/promises";

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
  input = process.stdin, inspectFilesystem = fsp.statfs,
  recordStop = recordStorageStop } = {}) {
  if (!outputPath || !Number.isSafeInteger(maximum) || maximum < 1 ||
      !Number.isSafeInteger(minimumFree) || minimumFree < 0) {
    throw new Error("Invalid transcript capture limits");
  }
  const existing = await fsp.stat(outputPath).then((stat) => stat.size, (error) => {
    if (error.code === "ENOENT") return 0;
    throw error;
  });
  let remaining = Math.max(0, maximum - existing);
  if (remaining === 0) return { stopped: "transcript_limit" };
  let output;
  let stopped = null;
  try {
    for await (const chunk of input) {
      const portion = chunk.subarray(0, Math.min(chunk.length, remaining));
      if (portion.length > 0 && minimumFree > 0) {
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
          break;
        }
      }
      if (portion.length > 0) {
        output ||= fs.createWriteStream(outputPath, { flags: "a", mode: 0o600 });
        if (!output.write(portion)) await once(output, "drain");
      }
      remaining -= portion.length;
      if (remaining === 0) { stopped = "transcript_limit"; break; }
    }
    if (output) { output.end(); await finished(output); }
    return { stopped };
  } catch (error) {
    output?.destroy();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [outputPath, rawMaximum, rawMinimumFree = "0"] = process.argv.slice(2);
  if (process.argv.length > 5 || !outputPath ||
      !/^[1-9]\d*$/.test(rawMaximum || "") || !/^(0|[1-9]\d*)$/.test(rawMinimumFree)) {
    process.exitCode = 64;
  } else {
    captureTranscript({ outputPath, maximum: Number(rawMaximum),
      minimumFree: Number(rawMinimumFree) }).catch(() => {
      // Neither paths nor terminal output belong in operational logs.
      process.exitCode = 1;
    });
  }
}

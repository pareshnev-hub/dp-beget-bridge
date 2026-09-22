import fs from "node:fs";
import fsp from "node:fs/promises";
import { once } from "node:events";
import { finished } from "node:stream/promises";

const [outputPath, rawMaximum] = process.argv.slice(2);
const maximum = Number(rawMaximum);

if (!outputPath || !Number.isSafeInteger(maximum) || maximum < 1) process.exit(64);

try {
  const existing = await fsp.stat(outputPath).then((stat) => stat.size, (error) => {
    if (error.code === "ENOENT") return 0;
    throw error;
  });
  let remaining = Math.max(0, maximum - existing);
  if (remaining === 0) process.exit(0);

  const output = fs.createWriteStream(outputPath, { flags: "a", mode: 0o600 });
  try {
    for await (const chunk of process.stdin) {
      const portion = chunk.subarray(0, Math.min(chunk.length, remaining));
      if (portion.length > 0 && !output.write(portion)) await once(output, "drain");
      remaining -= portion.length;
      if (remaining === 0) break;
    }
    output.end();
    await finished(output);
  } catch (error) {
    output.destroy();
    throw error;
  }
} catch {
  // Capture failure is intentionally silent: the Session Host exposes a
  // bounded degraded reason without copying paths or transcript bytes to logs.
  process.exitCode = 1;
}

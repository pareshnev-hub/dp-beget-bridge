#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);

export async function buildArtifact({ commit, outputDir, repository = process.cwd() }) {
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit) || !outputDir) {
    throw new Error("A full commit SHA and a new output directory are required");
  }
  const { stdout: revision } = await exec("git", ["rev-parse", "--verify", `${commit}^{commit}`], { cwd: repository });
  if (revision.trim() !== commit) throw new Error("Release commit did not resolve exactly");
  const { stdout: metadata } = await exec("git", ["show", `${commit}:package.json`], { cwd: repository });
  const packageInfo = JSON.parse(metadata);
  const version = packageInfo.version;
  if (packageInfo.name !== "dp-beget-bridge" || typeof version !== "string" ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Release commit has no valid DP Beget Bridge version");
  }
  const name = `dp-beget-bridge-${version}.tar.gz`;
  await mkdir(outputDir, { mode: 0o700 }); // Exclusive directory; never replace existing output.
  const tar = path.join(outputDir, ".source.tar");
  const artifact = path.join(outputDir, name);
  const manifest = path.join(outputDir, "manifest.json");
  try {
    await exec("git", ["archive", "--format=tar", `--prefix=dp-beget-bridge-${version}/`, `--output=${tar}`, commit], { cwd: repository });
    await pipeline(createReadStream(tar), createGzip({ level: 9, mtime: 0 }), createWriteStream(artifact, { flags: "wx", mode: 0o600 }));
    const size = (await stat(artifact)).size;
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(artifact)) hash.update(chunk);
    const record = { format: "dp-beget-bridge-release-v1", version, commit,
      artifact: { name, size, sha256: hash.digest("hex") } };
    const file = await open(manifest, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(record, null, 2) + "\n"); } finally { await file.close(); }
    return { artifact, manifest, version, commit };
  } finally {
    await rm(tar, { force: true });
  }
}

async function main(args) {
  if (args.length !== 4 || args[0] !== "--commit" || args[2] !== "--output-dir") {
    throw new Error("Usage: build-artifact --commit FULL_SHA --output-dir NEW_DIRECTORY");
  }
  const result = await buildArtifact({ commit: args[1], outputDir: args[3] });
  console.log(`Built candidate ${result.version} from ${result.commit} in ${path.resolve(args[3])}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Release build failed: ${error.message}`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { readRegularFile, verifyArtifact } from "./verify-artifact.mjs";

const MAX_COMPRESSED = 64 * 1024 * 1024;
const MAX_EXPANDED = 256 * 1024 * 1024;
const MAX_ENTRIES = 5000;

function octal(field) {
  const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(text)) throw new Error("Unsupported archive number encoding");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error("Archive number exceeds a safe limit");
  return value;
}

function nameField(bytes) {
  const end = bytes.indexOf(0);
  const value = bytes.subarray(0, end < 0 ? bytes.length : end);
  if (value.some(byte => byte < 32 || byte > 126)) throw new Error("Unsupported archive path encoding");
  return value.toString("ascii");
}

function assertHeader(header) {
  if (header.toString("ascii", 257, 262) !== "ustar") throw new Error("Unsupported archive header");
  const recorded = octal(header.subarray(148, 156));
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
  if (sum !== recorded) throw new Error("Archive header checksum mismatch");
}

export function inspectTar(bytes, version, commit) {
  const root = `dp-beget-bridge-${version}`;
  const entries = [];
  const directories = new Set();
  const names = new Set();
  let offset = 0;
  let globalHeader = false;
  let ended = false;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) { ended = true; break; }
    assertHeader(header);
    const type = String.fromCharCode(header[156]);
    const name = nameField(header.subarray(0, 100));
    const prefix = nameField(header.subarray(345, 500));
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = octal(header.subarray(124, 136));
    const start = offset + 512;
    const padded = Math.ceil(size / 512) * 512;
    if (size > MAX_EXPANDED || start + padded > bytes.length) throw new Error("Archive entry exceeds bounds");
    const content = bytes.subarray(start, start + size);
    offset = start + padded;
    if (!globalHeader) {
      if (type !== "g" || fullName !== "pax_global_header" ||
          content.toString("ascii") !== `52 comment=${commit}\n`) {
        throw new Error("Archive identity header does not match the signed commit");
      }
      globalHeader = true;
      continue;
    }
    if (type !== "0" && type !== "5") throw new Error("Archive links or special entries are prohibited");
    if (type === "5" && size !== 0) throw new Error("Archive directory contains data");
    if (type === "5" && !fullName.endsWith("/")) throw new Error("Invalid archive directory path");
    if (type === "0" && fullName.endsWith("/")) throw new Error("Invalid archive file path");
    const relative = fullName.endsWith("/") ? fullName.slice(0, -1) : fullName;
    if (relative !== root && !relative.startsWith(`${root}/`)) throw new Error("Archive path escapes release root");
    const segments = relative.split("/");
    if (segments.some(segment => !/^[a-zA-Z0-9._-]+$/.test(segment) || segment === "." || segment === "..")) {
      throw new Error("Unsafe archive path");
    }
    if (names.has(relative)) throw new Error("Duplicate archive path");
    const parent = segments.slice(0, -1).join("/");
    if (parent && !directories.has(parent)) throw new Error("Archive parent is not a directory");
    names.add(relative);
    if (type === "5") directories.add(relative);
    entries.push({ relative, directory: type === "5", content });
    if (entries.length > MAX_ENTRIES) throw new Error("Archive has too many entries");
  }
  if (!ended || !globalHeader || !directories.has(root) ||
      bytes.length - offset < 1024 || !bytes.subarray(offset).every(byte => byte === 0)) {
    throw new Error("Archive is incomplete or has trailing data");
  }
  return entries;
}

export async function extractVerifiedArtifact({ artifact, manifest, signature, trustedKey, outputDir }) {
  if (typeof outputDir !== "string" || !outputDir) throw new Error("A new extraction directory is required");
  const target = path.resolve(outputDir);
  if ([artifact, manifest, signature, trustedKey].some(value =>
    typeof value !== "string" || path.resolve(value) === target || path.resolve(value).startsWith(`${target}${path.sep}`))) {
    throw new Error("Release inputs must be outside the extraction directory");
  }
  const identity = await verifyArtifact({ artifact, manifest, signature, trustedKey });
  if (identity.size > MAX_COMPRESSED) throw new Error("Release archive exceeds extraction ceiling");
  const compressed = await readRegularFile(artifact, MAX_COMPRESSED);
  if (compressed.length !== identity.size || createHash("sha256").update(compressed).digest("hex") !== identity.sha256) {
    throw new Error("Release archive changed after verification");
  }
  let unpacked;
  try { unpacked = gunzipSync(compressed, { maxOutputLength: MAX_EXPANDED }); }
  catch { throw new Error("Invalid or oversized gzip release archive"); }
  const entries = inspectTar(unpacked, identity.version, identity.commit);
  await mkdir(target, { mode: 0o700 });
  try {
    for (const entry of entries) {
      const destination = path.join(target, entry.relative);
      if (entry.directory) await mkdir(destination, { mode: 0o700 });
      else {
        const file = await open(destination, "wx", 0o600);
        try { await file.writeFile(entry.content); } finally { await file.close(); }
      }
    }
    return { directory: path.join(target, `dp-beget-bridge-${identity.version}`),
      version: identity.version, commit: identity.commit, sha256: identity.sha256 };
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

async function main(args) {
  if (args.length !== 10 || args[0] !== "--artifact" || args[2] !== "--manifest" ||
      args[4] !== "--signature" || args[6] !== "--trusted-key" || args[8] !== "--output-dir") {
    throw new Error("Usage: extract-verified-artifact --artifact FILE --manifest FILE --signature FILE --trusted-key PINNED_KEY --output-dir NEW_DIRECTORY");
  }
  const result = await extractVerifiedArtifact({ artifact: args[1], manifest: args[3], signature: args[5],
    trustedKey: args[7], outputDir: args[9] });
  console.log(`Extracted verified release ${result.version} (${result.commit}), SHA-256 ${result.sha256}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Release extraction failed: ${error.message}`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ADMISSION_PAUSE_PATH } from "../../packages/core/src/admission-gate.js";

async function trustedDirectory(directory) {
  if (!path.isAbsolute(directory) || (await realpath(directory)) !== directory) {
    throw new Error("Admission gate directory must be a real absolute path");
  }
  const info = await stat(directory);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0 || (info.mode & 0o005) !== 0o005) {
    throw new Error("Admission gate directory must be traversable, root-owned and not writable by other users");
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function assertFlag(flag) {
  const info = await lstat(flag);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== 0 || (info.mode & 0o022) !== 0 || info.size > 128) {
    throw new Error("Admission gate flag is not a root-owned regular file");
  }
}

export async function verifyAdmissionPause({ flag = DEFAULT_ADMISSION_PAUSE_PATH } = {}) {
  if (process.getuid?.() !== 0 || !path.isAbsolute(flag)) {
    throw new Error("Root and an absolute admission flag path are required");
  }
  await trustedDirectory(path.dirname(flag));
  await assertFlag(flag);
  if (await readFile(flag, "utf8") !== "dp-beget-bridge-admission-paused-v1\n") {
    throw new Error("Unexpected admission pause flag content");
  }
  return { paused: true };
}

export async function pauseAdmission({ flag = DEFAULT_ADMISSION_PAUSE_PATH } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to pause admissions");
  if (!path.isAbsolute(flag)) throw new Error("Absolute admission gate flag path is required");
  const directory = path.dirname(flag);
  await trustedDirectory(path.dirname(directory));
  try { await mkdir(directory, { mode: 0o755 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  await trustedDirectory(directory);
  let handle;
  try { handle = await open(flag, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    await assertFlag(flag);
    return { paused: true, existing: true };
  }
  try { await handle.writeFile("dp-beget-bridge-admission-paused-v1\n"); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(directory);
  return { paused: true, existing: false };
}

export async function resumeAdmission({ flag = DEFAULT_ADMISSION_PAUSE_PATH, assertHealthy }) {
  if (process.getuid?.() !== 0 || typeof assertHealthy !== "function") {
    throw new Error("Root and a health verification callback are required to resume admissions");
  }
  if (!path.isAbsolute(flag)) throw new Error("Absolute admission gate flag path is required");
  const directory = path.dirname(flag);
  await trustedDirectory(directory);
  await assertFlag(flag);
  await assertHealthy();
  await assertFlag(flag);
  await unlink(flag);
  await syncDirectory(directory);
  return { paused: false };
}

async function main(args) {
  if (args.length !== 1 || args[0] !== "pause") {
    throw new Error("Usage: admission-pause pause (resume requires a verified updater transaction)");
  }
  const result = await pauseAdmission();
  console.log(result.existing ? "Admissions remain paused" : "Admissions paused for a verified update");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(`Admission pause failed (${error.code || "validation"})`);
    process.exitCode = 1;
  });
}

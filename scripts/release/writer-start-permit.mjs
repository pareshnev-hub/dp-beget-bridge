import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";
import { verifyMarker } from "./quiesce-legacy-writers.mjs";
import { WRITER_START_PERMIT, writerGuardContent } from "./writer-boot-guard.mjs";

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function assertWriterPermitAbsent(permit = WRITER_START_PERMIT) {
  writerGuardContent(PERSISTENT_MARKER, permit);
  try { await lstat(permit); throw new Error("Writer start permit remains active"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}

export async function withWriterStartPermit({ marker = PERSISTENT_MARKER,
  permit = WRITER_START_PERMIT, action } = {}) {
  if (process.getuid?.() !== 0 || typeof action !== "function") {
    throw new Error("Root and a controlled writer start action are required");
  }
  writerGuardContent(marker, permit);
  await verifyMarker(marker);
  const directory = path.dirname(permit);
  const parent = path.dirname(directory);
  const parentInfo = await stat(parent);
  if ((await realpath(parent)) !== parent || !parentInfo.isDirectory() ||
      parentInfo.uid !== 0 || (parentInfo.mode & 0o022) !== 0) {
    throw new Error("Untrusted writer permit parent");
  }
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = await stat(directory);
  if ((await realpath(directory)) !== directory || !info.isDirectory() ||
      info.uid !== 0 || (info.mode & 0o077) !== 0) throw new Error("Untrusted writer permit directory");
  const handle = await open(permit,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile("dp-beget-bridge-writer-start-v1\n"); await handle.sync(); }
  finally { await handle.close(); }
  try { await syncDirectory(directory); }
  catch (error) {
    try { await unlink(permit); await syncDirectory(directory); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Writer permit preparation and cleanup failed");
    }
    throw error;
  }
  let result;
  let actionError;
  try { result = await action(); }
  catch (error) { actionError = error; }
  let cleanupError;
  try { await unlink(permit); await syncDirectory(directory); }
  catch (error) { cleanupError = error; }
  if (cleanupError && actionError) {
    throw new AggregateError([actionError, cleanupError], "Writer startup and permit cleanup failed");
  }
  if (cleanupError) throw cleanupError;
  if (actionError) throw actionError;
  return result;
}

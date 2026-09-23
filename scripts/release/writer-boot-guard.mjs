import { constants } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { guardContent, PERSISTENT_MARKER } from "./ingress-boot-guard.mjs";
import { MANAGED_APP_UNITS } from "./stage-managed-unit-overrides.mjs";

export const WRITER_GUARD_DROP_IN = "80-dp-r0004-writer-guard.conf";
export const WRITER_START_PERMIT = "/run/dp-beget-bridge-migration/writer-start-allowed";

export function writerGuardContent(marker = PERSISTENT_MARKER, permit = WRITER_START_PERMIT) {
  guardContent(marker);
  if (!path.isAbsolute(permit) || !permit.startsWith("/run/") ||
      path.normalize(permit) !== permit || permit.endsWith("/") ||
      /[\r\n%\\ ]/.test(permit)) throw new Error("Writer permit must be an unambiguous ephemeral /run path");
  // Trigger conditions are ORed: without a migration marker, ordinary boot
  // works; under a marker, only the short-lived explicit permit starts writers.
  // /run disappears at reboot, so an interrupted migration cannot auto-start.
  return `[Unit]\nConditionPathExists=|!${marker}\nConditionPathExists=|${permit}\n`;
}

export async function stageWriterBootGuard({ outputDir, marker = PERSISTENT_MARKER,
  permit = WRITER_START_PERMIT } = {}) {
  if (process.getuid?.() !== 0 || !path.isAbsolute(outputDir || "") ||
      path.normalize(outputDir) !== outputDir) throw new Error("Root and a new absolute staging directory are required");
  const content = writerGuardContent(marker, permit);
  const parent = path.dirname(outputDir);
  const info = await stat(parent);
  if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0 ||
      (await realpath(parent)) !== parent) throw new Error("Untrusted writer guard staging parent");
  await mkdir(outputDir, { mode: 0o700 });
  for (const unit of MANAGED_APP_UNITS) {
    const directory = path.join(outputDir, `${unit}.d`);
    await mkdir(directory, { mode: 0o700 });
    const file = await open(path.join(directory, WRITER_GUARD_DROP_IN),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  const handle = await open(outputDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
  const parentHandle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parentHandle.sync(); } finally { await parentHandle.close(); }
  return { units: [...MANAGED_APP_UNITS], marker, permit, dropIn: WRITER_GUARD_DROP_IN };
}

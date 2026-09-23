import { lstat } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_ADMISSION_PAUSE_PATH = "/var/lib/dp-beget-bridge-maintenance/admission-paused";

export async function isAdmissionPaused(filename = DEFAULT_ADMISSION_PAUSE_PATH) {
  if (typeof filename !== "string" || !path.isAbsolute(filename)) return true;
  try {
    // Any existing entry, including a corrupt or linked one, keeps the gate shut.
    await lstat(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    // I/O and permission errors fail closed rather than reopening ingress.
    return true;
  }
}

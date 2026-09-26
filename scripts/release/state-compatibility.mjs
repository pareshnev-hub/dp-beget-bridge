import { lstat } from "node:fs/promises";
import path from "node:path";
import { readRegularFile } from "./verify-artifact.mjs";

const SCHEMAS = ["sessionHost", "agent", "oauth"];

export async function readStateCompatibility(directory) {
  const filename = path.join(directory, "release-compatibility.json");
  let info;
  try { info = await lstat(filename); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error("Release has no state compatibility record");
    throw error;
  }
  if (!info.isFile() || info.nlink !== 1) throw new Error("Release has no trusted state compatibility record");
  let record;
  try { record = JSON.parse(await readRegularFile(filename, 4096)); }
  catch { throw new Error("Invalid release state compatibility record"); }
  const schemas = record?.schemas;
  if (record?.format !== "dp-beget-state-compatibility-v1" ||
      Object.keys(record).sort().join() !== "format,schemas" ||
      typeof schemas !== "object" || schemas === null || Array.isArray(schemas) ||
      Object.keys(schemas).sort().join() !== [...SCHEMAS].sort().join() ||
      SCHEMAS.some(name => !Number.isSafeInteger(schemas[name]) || schemas[name] < 1 ||
        schemas[name] > 1000)) {
    throw new Error("Invalid release state compatibility record");
  }
  return schemas;
}

export function assertSameStateSchemas(candidate, active) {
  if (SCHEMAS.some(name => candidate[name] !== active[name])) {
    throw new Error("State schema change requires a separate verified migration and rollback transaction");
  }
}

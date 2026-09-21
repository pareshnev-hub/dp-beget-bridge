import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["apps", "packages", "scripts", "test"];
const files = [];

async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(candidate);
    else if (entry.isFile() && (candidate.endsWith(".js") || candidate.endsWith(".mjs"))) files.push(candidate);
  }
}

for (const root of roots) await walk(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Checked ${files.length} JavaScript files.`);

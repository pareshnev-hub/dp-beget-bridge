import { execFile } from "node:child_process";
import { lstat, readFile, readlink, realpath, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MAX_ENTRIES = 100000;

function within(root, filename) { return filename === root || filename.startsWith(`${root}${path.sep}`); }

export async function inspectInstalledTree(root, hasDependencies) {
  const modules = path.join(root, "node_modules");
  let modulesInfo;
  try { modulesInfo = await lstat(modules); }
  catch (error) { if (error.code === "ENOENT" && !hasDependencies) return; throw error; }
  if (!modulesInfo.isDirectory()) throw new Error("Installed dependency root is not a real directory");
  let entries = 0;
  async function walk(directory) {
    for (const name of await readdir(directory)) {
      if (++entries > MAX_ENTRIES) throw new Error("Installed dependency tree exceeds its entry limit");
      const filename = path.join(directory, name);
      const info = await lstat(filename);
      if (info.isSymbolicLink()) {
        if (path.isAbsolute(await readlink(filename))) throw new Error("Installed dependency has an absolute link");
        const resolved = await realpath(filename);
        if (!within(root, resolved)) throw new Error("Installed dependency link leaves the release tree");
      } else if (info.isDirectory()) await walk(filename);
      else if (!info.isFile()) throw new Error("Installed dependency contains a special file");
    }
  }
  await walk(modules);
}

export async function installQuarantinedDependencies({ directory, version, workspace }) {
  if (!path.isAbsolute(directory || "") || !path.isAbsolute(workspace || "") ||
      !directory.startsWith(`${path.resolve(workspace)}${path.sep}`)) {
    throw new Error("Dependencies must be installed inside a private quarantine workspace");
  }
  const pkg = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(directory, "package-lock.json"), "utf8"));
  if (pkg.name !== "dp-beget-bridge" || pkg.version !== version ||
      lock.name !== pkg.name || lock.version !== version ||
      lock.packages?.[""]?.name !== pkg.name || lock.packages[""].version !== version ||
      lock.lockfileVersion !== 3) {
    throw new Error("Signed package and lockfile identity do not match the release");
  }
  const cache = path.join(workspace, "npm-cache");
  try {
    // npm may fetch integrity-pinned packages, but cannot run package lifecycle scripts.
    // Its cache and configuration are private to this one quarantine transaction.
    await exec("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier",
      "--cache", cache], {
      cwd: directory,
      timeout: 180000,
      maxBuffer: 256 * 1024,
      env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C", npm_config_cache: cache,
        npm_config_userconfig: path.join(workspace, "nonexistent-user-config"),
        npm_config_globalconfig: path.join(workspace, "nonexistent-global-config"),
        npm_config_ignore_scripts: "true" }
    });
    await inspectInstalledTree(directory, Object.keys(pkg.dependencies || {}).length > 0);
  } catch (error) {
    throw new Error(`Private dependency preparation failed (${error.code || "validation"})`);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
  return { directory, version };
}

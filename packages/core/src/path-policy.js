import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BridgeError } from "./errors.js";

const DIRECTORY_OPEN_FLAGS = fs.constants.O_RDONLY
  | fs.constants.O_DIRECTORY
  | fs.constants.O_NOFOLLOW;
const exec = promisify(execFile);

function isWithin(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function procFdPath(handle, name = "") {
  return path.join(`/proc/self/fd/${handle.fd}`, name);
}

export class PathPolicy {
  constructor(roots, { fileSystem = fsp, workspaceSharing = "private" } = {}) {
    this.roots = roots.map((root) => path.resolve(root));
    this.fileSystem = fileSystem;
    if (!["private", "ipc-group"].includes(workspaceSharing)) {
      throw new BridgeError("invalid_config", "Unsupported workspace sharing policy", 500);
    }
    this.workspaceSharing = workspaceSharing;
    this.createdDirectoryMode = workspaceSharing === "ipc-group" ? 0o2770 : 0o700;
    if (this.roots.length === 0) {
      throw new BridgeError("invalid_config", "At least one allowed root is required", 500);
    }
    this.canonicalRoots = this.roots.map((root) => {
      try {
        return fs.realpathSync(root);
      } catch {
        throw new BridgeError("invalid_config", `Allowed root does not exist: ${root}`, 500);
      }
    });
    this.sharedGroups = new Map();
    if (workspaceSharing === "ipc-group") {
      if (process.platform !== "linux" || (process.umask() & 0o070) !== 0) {
        throw new BridgeError("invalid_config", "Shared workspace requires Linux and a group-writable creation mask", 500);
      }
      const groups = new Set([process.getgid(), ...process.getgroups()]);
      for (const [index, root] of this.canonicalRoots.entries()) {
        const stat = fs.lstatSync(root);
        if (this.roots[index] !== root || !stat.isDirectory() || stat.gid === 0 ||
            !groups.has(stat.gid) || (stat.mode & 0o7777) !== 0o2770) {
          throw new BridgeError("invalid_config", "Shared workspace requires an isolated group and private setgid root", 500);
        }
        this.sharedGroups.set(root, stat.gid);
      }
    }
  }

  resolve(candidate) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new BridgeError("invalid_path", "Path must be a non-empty string");
    }
    const resolved = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(this.roots[0], candidate);
    const missing = [];
    let existing = resolved;
    while (!fs.existsSync(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
    let canonical = fs.existsSync(existing) ? fs.realpathSync(existing) : existing;
    for (const segment of missing) canonical = path.join(canonical, segment);
    const allowed = this.roots.some(
      (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
    );
    if (!allowed) {
      throw new BridgeError("path_not_allowed", "Path is outside configured roots", 403);
    }
    const canonicalAllowed = this.canonicalRoots.some(
      (root) => canonical === root || canonical.startsWith(`${root}${path.sep}`),
    );
    if (!canonicalAllowed) {
      throw new BridgeError("path_not_allowed", "Path resolves outside configured roots", 403);
    }
    return canonical;
  }

  mutation(candidate) {
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new BridgeError("invalid_path", "Path must be a non-empty string");
    }
    const resolved = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(this.roots[0], candidate);
    const matches = [];
    for (let index = 0; index < this.roots.length; index += 1) {
      for (const base of new Set([this.roots[index], this.canonicalRoots[index]])) {
        if (isWithin(resolved, base)) matches.push({ index, base });
      }
    }
    matches.sort((left, right) => right.base.length - left.base.length);
    const match = matches[0];
    if (!match) {
      throw new BridgeError("path_not_allowed", "Path is outside configured roots", 403);
    }
    const relative = path.relative(match.base, resolved);
    if (!relative || relative === ".") {
      throw new BridgeError("protected_workspace_root", "Configured workspace root cannot be mutated", 403);
    }
    const segments = relative.split(path.sep);
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      throw new BridgeError("invalid_path", "Mutation path is invalid");
    }
    const root = this.canonicalRoots[match.index];
    return Object.freeze({
      root,
      relative,
      segments: Object.freeze(segments),
      displayPath: path.join(root, ...segments),
    });
  }

  assertNoDangerousOverlap(source, destination) {
    if (source.root !== destination.root) return;
    if (source.relative === destination.relative) return;
    const sourcePrefix = `${source.relative}${path.sep}`;
    const destinationPrefix = `${destination.relative}${path.sep}`;
    if (destination.relative.startsWith(sourcePrefix) || source.relative.startsWith(destinationPrefix)) {
      throw new BridgeError(
        "dangerous_path_overlap",
        "Ancestor and descendant mutation paths cannot overlap",
        409,
      );
    }
  }

  async assertPinnedDirectory(handle, root) {
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      throw new BridgeError("path_not_allowed", "Mutation parent is not a directory", 403);
    }
    const actual = await this.fileSystem.realpath(procFdPath(handle));
    if (!isWithin(actual.replace(/ \(deleted\)$/, ""), root) || actual.endsWith(" (deleted)")) {
      throw new BridgeError("path_not_allowed", "Mutation path escaped its configured root", 403);
    }
  }

  async openMutationParent(reference, { createParents = false } = {}) {
    const target = typeof reference === "string" ? this.mutation(reference) : reference;
    let current;
    try {
      current = await this.fileSystem.open(target.root, DIRECTORY_OPEN_FLAGS);
      await this.assertPinnedDirectory(current, target.root);
      for (const segment of target.segments.slice(0, -1)) {
        const nextPath = procFdPath(current, segment);
        if (createParents) {
          await this.assertSharedUploadParent(current, target.root);
          try {
            await this.fileSystem.mkdir(nextPath, { mode: this.createdDirectoryMode });
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          }
        }
        let next;
        try {
          next = await this.fileSystem.open(nextPath, DIRECTORY_OPEN_FLAGS);
        } catch (error) {
          if (["ELOOP", "ENOTDIR"].includes(error.code)) {
            throw new BridgeError("path_not_allowed", "Mutation path contains a link or non-directory", 403);
          }
          throw error;
        }
        await this.assertPinnedDirectory(next, target.root);
        await current.close();
        current = next;
      }
      if (createParents) await this.assertSharedUploadParent(current, target.root);
      const handle = current;
      current = undefined;
      return {
        reference: target,
        path: procFdPath(handle, target.segments.at(-1)),
        parentPath: procFdPath(handle),
        assertUploadParent: () => this.assertSharedUploadParent(handle, target.root),
        async close() { await handle.close(); },
      };
    } catch (error) {
      await current?.close().catch(() => {});
      throw error;
    }
  }

  async assertSharedUploadParent(handle, root) {
    if (this.workspaceSharing !== "ipc-group") return;
    const stat = await handle.stat();
    if (stat.gid !== this.sharedGroups.get(root) || (stat.mode & 0o7777) !== 0o2770) {
      throw new BridgeError("workspace_permissions_changed", "Upload parent no longer has the isolated shared workspace permissions", 409);
    }
    // Named/default ACLs could grant inherited upload access beyond IPC.
    // Inspect the held parent descriptor, never a newly resolved pathname.
    let acl;
    try {
      acl = await exec("getfacl", ["-c", "-p", "-n", `/proc/${process.pid}/fd/${handle.fd}`],
        { timeout: 5000, maxBuffer: 8192, env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" } });
    } catch {
      throw new BridgeError("workspace_permissions_changed", "Shared upload parent ACL is unproven", 409);
    }
    if (acl.stderr.trim() || acl.stdout.trim() !== "user::rwx\ngroup::rwx\nother::---") {
      throw new BridgeError("workspace_permissions_changed", "Shared upload parent has extended or default ACLs", 409);
    }
  }
}

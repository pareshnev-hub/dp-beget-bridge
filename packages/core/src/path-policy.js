import fs from "node:fs";
import path from "node:path";
import { BridgeError } from "./errors.js";

export class PathPolicy {
  constructor(roots) {
    this.roots = roots.map((root) => path.resolve(root));
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
}

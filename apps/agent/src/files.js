import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { BridgeError } from "../../../packages/core/src/errors.js";
import { sizeBucket } from "./telemetry.js";

export class FileManager {
  constructor({
    pathPolicy,
    logger,
    telemetry = { track() {} },
    uploadMaxBytes,
    fileSystem = fsp,
  }) {
    this.pathPolicy = pathPolicy;
    this.logger = logger;
    this.uploadMaxBytes = uploadMaxBytes;
    this.telemetry = telemetry;
    this.fileSystem = fileSystem;
  }

  async list(candidate) {
    this.telemetry.trackActivity?.();
    const resolved = this.pathPolicy.resolve(candidate);
    const entries = await fsp.readdir(resolved, { withFileTypes: true });
    const result = await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(resolved, entry.name);
      const stat = await fsp.stat(entryPath);
      return {
        name: entry.name,
        path: entryPath,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      };
    }));
    return { path: resolved, entries: result };
  }

  async upload(request, candidate, overwrite = false) {
    const destination = this.pathPolicy.resolve(candidate);
    this.telemetry.trackActivity?.();
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    if (!overwrite) {
      try {
        await fsp.access(destination);
        throw new BridgeError("destination_exists", "Destination already exists", 409);
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        if (error.code !== "ENOENT") throw error;
      }
    }

    const temporary = `${destination}.dpb-part-${crypto.randomUUID()}`;
    const hash = crypto.createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform: (chunk, _encoding, callback) => {
        size += chunk.length;
        if (size > this.uploadMaxBytes) {
          callback(new BridgeError("file_too_large", "Upload exceeds configured limit", 413));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(request, meter, fs.createWriteStream(temporary, { mode: 0o600, flags: "wx" }));
      await fsp.rename(temporary, destination);
    } catch (error) {
      await fsp.rm(temporary, { force: true });
      throw error;
    }
    const sha256 = hash.digest("hex");
    this.logger.info("file.uploaded", { path: destination, size, sha256 });
    this.telemetry.track("file_transferred", { direction: "upload", sizeBucket: sizeBucket(size) });
    return { path: destination, size, sha256 };
  }

  recordDownload(size) {
    this.telemetry.trackActivity?.();
    this.telemetry.track("file_transferred", { direction: "download", sizeBucket: sizeBucket(size) });
  }

  async stat(candidate) {
    const resolved = this.pathPolicy.resolve(candidate);
    const stat = await fsp.stat(resolved);
    if (!stat.isFile()) throw new BridgeError("not_a_file", "Path is not a regular file", 400);
    return { path: resolved, size: stat.size, modifiedAt: stat.mtime.toISOString() };
  }

  createReadStream(candidate) {
    const resolved = this.pathPolicy.resolve(candidate);
    return { path: resolved, stream: fs.createReadStream(resolved) };
  }

  async copy(source, destination, overwrite = false) {
    this.telemetry.trackActivity?.();
    const from = this.pathPolicy.resolve(source);
    const to = this.pathPolicy.resolve(destination);
    await fsp.cp(from, to, { recursive: true, force: Boolean(overwrite), errorOnExist: !overwrite });
    this.logger.info("file.copied", { source: from, destination: to });
    return { source: from, destination: to, copied: true };
  }

  async move(source, destination, overwrite = false) {
    this.telemetry.trackActivity?.();
    const from = this.pathPolicy.resolve(source);
    const to = this.pathPolicy.resolve(destination);

    // Resolve source existence before inspecting or changing the destination.
    // This is also important when source and destination are the same path.
    await this.fileSystem.lstat(from);
    if (from === to) {
      return { source: from, destination: to, moved: false, reason: "same_path" };
    }

    if (!overwrite) {
      try {
        await this.fileSystem.access(to);
        throw new BridgeError("destination_exists", "Destination already exists", 409);
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        if (error.code !== "ENOENT") throw error;
      }
    }

    try {
      // On the supported Linux platform rename is the commit operation. Never
      // pre-delete the destination: if rename fails, both paths remain intact.
      await this.fileSystem.rename(from, to);
    } catch (error) {
      if (error.code !== "EXDEV") throw error;
      throw new BridgeError(
        "unsupported_cross_device_move",
        "Cross-device move is not safely supported",
        409,
      );
    }
    this.logger.info("file.moved", { source: from, destination: to });
    return { source: from, destination: to, moved: true };
  }

  async remove(candidate, recursive = false) {
    this.telemetry.trackActivity?.();
    const resolved = this.pathPolicy.resolve(candidate);
    await fsp.rm(resolved, { recursive: Boolean(recursive), force: false });
    this.logger.warn("file.deleted", { path: resolved, recursive: Boolean(recursive) });
    return { path: resolved, deleted: true };
  }
}

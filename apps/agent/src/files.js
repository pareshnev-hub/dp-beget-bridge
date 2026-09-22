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
    storageMinFreeBytes = 0,
    maxConcurrent = 2,
    fileSystem = fsp,
  }) {
    this.pathPolicy = pathPolicy;
    this.logger = logger;
    this.uploadMaxBytes = uploadMaxBytes;
    this.storageMinFreeBytes = storageMinFreeBytes;
    this.maxConcurrent = maxConcurrent;
    this.activeTransfers = 0;
    this.telemetry = telemetry;
    this.fileSystem = fileSystem;
  }

  acquireTransfer(kind) {
    if (this.activeTransfers >= this.maxConcurrent) {
      this.logger.warn("file.transfer_rejected", {
        reason: "concurrency",
        kind,
        active: this.activeTransfers,
        limit: this.maxConcurrent,
      });
      throw new BridgeError("transfer_busy", "File transfer concurrency limit reached", 429);
    }
    this.activeTransfers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeTransfers -= 1;
    };
  }

  async assertStorageReserve(target, incomingBytes = 0) {
    const reserve = BigInt(this.storageMinFreeBytes || 0);
    if (reserve === 0n) return;
    const stat = await this.fileSystem.statfs(target);
    const available = BigInt(stat.bavail) * BigInt(stat.bsize);
    const incoming = BigInt(Math.max(0, Number(incomingBytes) || 0));
    if (available < reserve + incoming) {
      this.logger.warn("file.write_rejected", { reason: "storage_reserve" });
      throw new BridgeError("storage_reserve", "Write rejected to preserve configured free disk space", 507);
    }
  }

  destinationExists(error) {
    if (error?.code !== "EEXIST") throw error;
    throw new BridgeError("destination_exists", "Destination already exists", 409);
  }

  unsupportedComplex(message = "Complex workspace mutation is not safely supported") {
    return new BridgeError("unsupported_complex_mutation", message, 409);
  }

  async commitTemporary(temporary, destination, overwrite) {
    if (overwrite) {
      await this.fileSystem.rename(temporary, destination);
      return;
    }
    try {
      await this.fileSystem.link(temporary, destination);
    } catch (error) {
      this.destinationExists(error);
    }
    await this.fileSystem.unlink(temporary);
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
    const release = this.acquireTransfer("upload");
    try {
      const destination = this.pathPolicy.mutation(candidate);
      this.telemetry.trackActivity?.();
      const pinned = await this.pathPolicy.openMutationParent(destination, { createParents: true });
      const temporary = path.join(pinned.parentPath, `.dpb-part-${crypto.randomUUID()}`);
      const hash = crypto.createHash("sha256");
      const declaredLength = Number.parseInt(request.headers?.["content-length"] || "", 10);
      if (Number.isFinite(declaredLength) && declaredLength > this.uploadMaxBytes) {
        await pinned.close();
        throw new BridgeError("file_too_large", "Upload exceeds configured limit", 413);
      }
      let size = 0;
      const meter = new Transform({
        transform: (chunk, _encoding, callback) => {
          size += chunk.length;
          if (size > this.uploadMaxBytes) {
            callback(new BridgeError("file_too_large", "Upload exceeds configured limit", 413));
            return;
          }
          this.assertStorageReserve(pinned.parentPath, chunk.length).then(() => {
            hash.update(chunk);
            callback(null, chunk);
          }, callback);
        },
      });
      try {
        await this.assertStorageReserve(
          pinned.parentPath,
          Number.isFinite(declaredLength) ? declaredLength : 1,
        );
        await pipeline(request, meter, fs.createWriteStream(temporary, { mode: 0o600, flags: "wx" }));
        await this.commitTemporary(temporary, pinned.path, overwrite);
      } catch (error) {
        await this.fileSystem.rm(temporary, { force: true }).catch(() => {});
        throw error;
      } finally {
        await pinned.close();
      }
      const sha256 = hash.digest("hex");
      this.logger.info("file.uploaded", { size });
      this.telemetry.track("file_transferred", { direction: "upload", sizeBucket: sizeBucket(size) });
      return { path: destination.displayPath, size, sha256 };
    } finally {
      release();
    }
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
    const from = this.pathPolicy.mutation(source);
    const to = this.pathPolicy.mutation(destination);
    if (from.displayPath === to.displayPath) {
      return { source: from.displayPath, destination: to.displayPath, copied: false, reason: "same_path" };
    }
    this.pathPolicy.assertNoDangerousOverlap(from, to);

    const sourceParent = await this.pathPolicy.openMutationParent(from);
    let destinationParent;
    let sourceHandle;
    let temporary;
    try {
      try {
        sourceHandle = await this.fileSystem.open(
          sourceParent.path,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (error.code === "ELOOP") throw this.unsupportedComplex("Symlink copy is not safely supported");
        throw error;
      }
      const sourceStat = await sourceHandle.stat();
      if (!sourceStat.isFile()) {
        throw this.unsupportedComplex("Recursive or non-regular copy is not safely supported");
      }
      destinationParent = await this.pathPolicy.openMutationParent(to);
      await this.assertStorageReserve(destinationParent.parentPath, sourceStat.size);
      temporary = path.join(destinationParent.parentPath, `.dpb-copy-${crypto.randomUUID()}`);
      await this.fileSystem.copyFile(
        `/proc/self/fd/${sourceHandle.fd}`,
        temporary,
        fs.constants.COPYFILE_EXCL,
      );
      await this.commitTemporary(temporary, destinationParent.path, overwrite);
      temporary = undefined;
    } finally {
      if (temporary) await this.fileSystem.rm(temporary, { force: true }).catch(() => {});
      await sourceHandle?.close().catch(() => {});
      await destinationParent?.close().catch(() => {});
      await sourceParent.close().catch(() => {});
    }
    this.logger.info("file.copied");
    return { source: from.displayPath, destination: to.displayPath, copied: true };
  }

  async move(source, destination, overwrite = false) {
    this.telemetry.trackActivity?.();
    const from = this.pathPolicy.mutation(source);
    const to = this.pathPolicy.mutation(destination);
    if (from.displayPath === to.displayPath) {
      return { source: from.displayPath, destination: to.displayPath, moved: false, reason: "same_path" };
    }
    this.pathPolicy.assertNoDangerousOverlap(from, to);

    const sourceParent = await this.pathPolicy.openMutationParent(from);
    let destinationParent;
    try {
      const sourceStat = await this.fileSystem.lstat(sourceParent.path);
      if (!sourceStat.isFile()) {
        throw this.unsupportedComplex("Directory and symlink moves are not safely supported");
      }
      destinationParent = await this.pathPolicy.openMutationParent(to);
      if (overwrite) {
        try {
          const destinationStat = await this.fileSystem.lstat(destinationParent.path);
          if (destinationStat.isDirectory()) {
            throw this.unsupportedComplex("Directory replacement is not safely supported");
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await this.fileSystem.rename(sourceParent.path, destinationParent.path);
      } else {
        try {
          await this.fileSystem.link(sourceParent.path, destinationParent.path);
        } catch (error) {
          this.destinationExists(error);
        }
        try {
          await this.fileSystem.unlink(sourceParent.path);
        } catch (error) {
          await this.fileSystem.unlink(destinationParent.path).catch(() => {});
          throw error;
        }
      }
    } catch (error) {
      if (error.code !== "EXDEV") throw error;
      throw new BridgeError(
        "unsupported_cross_device_move",
        "Cross-device move is not safely supported",
        409,
      );
    } finally {
      await destinationParent?.close().catch(() => {});
      await sourceParent.close().catch(() => {});
    }
    this.logger.info("file.moved");
    return { source: from.displayPath, destination: to.displayPath, moved: true };
  }

  async remove(candidate, recursive = false) {
    this.telemetry.trackActivity?.();
    const resolved = this.pathPolicy.mutation(candidate);
    if (recursive) {
      throw this.unsupportedComplex("Recursive delete is not safely supported");
    }
    const pinned = await this.pathPolicy.openMutationParent(resolved);
    try {
      const stat = await this.fileSystem.lstat(pinned.path);
      if (stat.isDirectory()) await this.fileSystem.rmdir(pinned.path);
      else await this.fileSystem.unlink(pinned.path);
    } finally {
      await pinned.close();
    }
    this.logger.warn("file.deleted", { recursive: Boolean(recursive) });
    return { path: resolved.displayPath, deleted: true };
  }
}

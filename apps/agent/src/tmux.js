import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BridgeError } from "../../../packages/core/src/errors.js";
import { durationBucket } from "./telemetry.js";

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const SAFE_IDEMPOTENCY_KEY = /^[a-zA-Z0-9._:-]{1,128}$/;
const CURSOR_VERSION = 1;
const CAPTURE_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/transcript-capture.mjs",
);

function encodeCursor(session, offset) {
  return `v${CURSOR_VERSION}:${session.transcriptStreamId}:${session.transcriptEpoch}:${offset}`;
}

function parseCursor(value, session) {
  if (value === undefined || value === null || value === "") return { offset: session.transcriptEarliestOffset };
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const offset = Number(value);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new BridgeError("invalid_cursor", "Invalid transcript cursor");
    return { offset };
  }
  const match = String(value).match(/^v(\d+):([a-zA-Z0-9_-]{1,80}):(\d+):(\d+)$/);
  if (!match) throw new BridgeError("invalid_cursor", "Invalid transcript cursor");
  const [, version, streamId, epoch, offset] = match;
  const parsedEpoch = Number(epoch);
  const parsedOffset = Number(offset);
  if (
    Number(version) !== CURSOR_VERSION
    || !Number.isSafeInteger(parsedEpoch)
    || parsedEpoch < 1
    || !Number.isSafeInteger(parsedOffset)
  ) {
    throw new BridgeError("invalid_cursor", "Unsupported transcript cursor");
  }
  return {
    offset: parsedOffset,
    mismatch: streamId !== session.transcriptStreamId || parsedEpoch !== session.transcriptEpoch,
  };
}

function utf8SequenceLength(byte) {
  if ((byte & 0x80) === 0) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

function utf8SafePrefixLength(buffer, preferredLength) {
  let length = Math.min(preferredLength, buffer.length);
  if (length === 0) return 0;
  let lead = length - 1;
  while (lead > 0 && (buffer[lead] & 0xc0) === 0x80) lead -= 1;
  const expected = utf8SequenceLength(buffer[lead]);
  if (lead + expected > length) length = lead;
  if (length === 0 && buffer.length > 0) {
    const firstLength = utf8SequenceLength(buffer[0]);
    if (firstLength <= buffer.length) return firstLength;
  }
  return length;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export class TmuxSessionManager {
  constructor({ config, store, pathPolicy, logger, telemetry = { track() {} } }) {
    this.config = config;
    this.store = store;
    this.pathPolicy = pathPolicy;
    this.logger = logger;
    this.telemetry = telemetry;
    this.largeOutputWarnings = new Set();
    this.fingerprintKeyPromise = null;
    this.operationMonitors = new Map();
    this.pendingOpens = 0;
    this.openAdmission = Promise.resolve();
  }

  tmuxName(id) {
    if (!SAFE_ID.test(id)) throw new BridgeError("invalid_session_id", "Invalid session ID");
    return `dpb_${id}`;
  }

  tmuxArgs(args) {
    return this.config.tmuxSocket ? ["-S", this.config.tmuxSocket, ...args] : args;
  }

  async ensureSocketDirectory() {
    if (this.config.tmuxSocket) {
      await fs.mkdir(path.dirname(this.config.tmuxSocket), { recursive: true, mode: 0o700 });
    }
  }

  async tmux(args, options = {}) {
    try {
      await this.ensureSocketDirectory();
      return await execFileAsync(this.config.tmuxBin, this.tmuxArgs(args), {
        maxBuffer: 4 * 1024 * 1024,
        ...options,
      });
    } catch (error) {
      throw new BridgeError(
        "tmux_error",
        error.stderr?.trim() || error.message || "tmux command failed",
        500,
      );
    }
  }

  async isAlive(id) {
    try {
      await this.ensureSocketDirectory();
      await execFileAsync(this.config.tmuxBin, this.tmuxArgs(["has-session", "-t", this.tmuxName(id)]));
      return true;
    } catch {
      return false;
    }
  }

  async reserveOpenSlot() {
    let unlock;
    const previous = this.openAdmission;
    this.openAdmission = new Promise((resolve) => { unlock = resolve; });
    await previous;
    try {
      const sessions = await this.store.list();
      const open = sessions.filter((session) => !session.closedAt);
      const alive = await Promise.all(open.map((session) => this.isAlive(session.id)));
      const active = alive.filter(Boolean).length;
      const maximum = Math.max(1, Number(this.config.terminalMaxActive || 8));
      if (active + this.pendingOpens >= maximum) {
        throw new BridgeError("session_limit", "Active terminal session limit reached", 429);
      }
      this.pendingOpens += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.pendingOpens -= 1;
      };
    } finally {
      unlock();
    }
  }

  async open({ cwd = ".", label = "Terminal" }) {
    const releaseSlot = await this.reserveOpenSlot();
    let created = false;
    const id = crypto.randomUUID();
    const name = this.tmuxName(id);
    try {
      const resolvedCwd = this.pathPolicy.resolve(cwd);
      const session = {
        id,
        label: String(label).slice(0, 120),
        cwd: resolvedCwd,
        createdAt: new Date().toISOString(),
        closedAt: null,
        transcriptStreamId: crypto.randomUUID(),
        transcriptEpoch: 1,
        transcriptEarliestOffset: 0,
        transcriptCaptureState: "ACTIVE",
        transcriptGapReason: null,
      };

      await fs.mkdir(this.store.sessionDir(id), { recursive: true, mode: 0o700 });
      await fs.writeFile(this.store.outputPath(id), "", { mode: 0o600 });
      await this.tmux(["new-session", "-d", "-s", name, "-c", resolvedCwd, "bash", "--noprofile", "--norc"]);
      created = true;
      await this.tmux(["set-option", "-t", name, "history-limit", String(this.config.historyLines)]);
      await this.tmux([
        "pipe-pane",
        "-o",
        "-t",
        name,
        `/usr/bin/env node ${shellQuote(CAPTURE_SCRIPT)} ${shellQuote(this.store.outputPath(id))} ${Math.max(1, Number(this.config.sessionOutputMaxBytes || 64 * 1024 * 1024))}`,
      ]);
      const saved = await this.store.save(session);
      this.telemetry.trackActivity?.();
      this.logger.info("terminal.opened", { sessionId: id });
      this.telemetry.track("terminal_opened");
      return { ...saved, alive: true };
    } catch (error) {
      if (created) await this.tmux(["kill-session", "-t", name]).catch(() => {});
      await fs.rm(this.store.sessionDir(id), { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      releaseSlot();
    }
  }

  async list() {
    const sessions = await this.store.list();
    return Promise.all(sessions.map(async (session) => ({ ...session, alive: await this.isAlive(session.id) })));
  }

  async requireSession(id) {
    const session = await this.store.get(id);
    if (!session) throw new BridgeError("session_not_found", "Terminal session not found", 404);
    if (session.closedAt) throw new BridgeError("session_not_running", "Terminal session is closed", 409);
    if (!(await this.isAlive(id))) {
      throw new BridgeError("session_not_running", "Terminal session is not running", 409);
    }
    return session;
  }

  async outputRange(id, session = undefined) {
    const current = session || await this.store.get(id);
    if (!current) throw new BridgeError("session_not_found", "Terminal session not found", 404);
    try {
      const size = (await fs.stat(this.store.outputPath(id))).size;
      if (size >= this.config.sessionOutputWarnBytes && !this.largeOutputWarnings.has(id)) {
        this.largeOutputWarnings.add(id);
        this.logger.warn("terminal.output_retention_warning", { sessionId: id, size });
      }
      return {
        earliest: current.transcriptEarliestOffset,
        end: current.transcriptEarliestOffset + size,
        physicalSize: size,
      };
    } catch (error) {
      if (error.code === "ENOENT") {
        if (current.transcriptCaptureState !== "DEGRADED") {
          Object.assign(current, await this.store.updateTranscript(id, {
            captureState: "DEGRADED",
            gapReason: "transcript_missing",
          }));
        }
        return {
          earliest: current.transcriptEarliestOffset,
          end: current.transcriptEarliestOffset,
          physicalSize: 0,
        };
      }
      throw error;
    }
  }

  async outputSize(id) {
    return (await this.outputRange(id)).end;
  }

  async availableStorageBytes() {
    const stat = await fs.statfs(this.store.dataDir);
    return Number(BigInt(stat.bavail) * BigInt(stat.bsize));
  }

  async enforceCaptureReserve(id, session, alive) {
    const minimum = Number(this.config.storageMinFreeBytes || 0);
    if (!alive || session.transcriptCaptureState !== "ACTIVE" || minimum <= 0) return session;
    const available = await this.availableStorageBytes();
    if (available >= minimum) return session;
    await this.tmux(["pipe-pane", "-t", this.tmuxName(id)]);
    const degraded = await this.store.updateTranscript(id, {
      captureState: "DEGRADED",
      gapReason: "storage_reserve",
    });
    this.logger.warn("terminal.capture_degraded", { sessionId: id, reason: "storage_reserve" });
    return degraded;
  }

  async enforceCaptureCeiling(id, session, alive, range) {
    const maximum = Number(this.config.sessionOutputMaxBytes || 0);
    if (
      !alive
      || session.transcriptCaptureState !== "ACTIVE"
      || maximum <= 0
      || range.physicalSize < maximum
    ) {
      return session;
    }
    await this.tmux(["pipe-pane", "-t", this.tmuxName(id)]);
    const degraded = await this.store.updateTranscript(id, {
      captureState: "DEGRADED",
      gapReason: "transcript_limit",
    });
    this.logger.warn("terminal.capture_degraded", { sessionId: id, reason: "transcript_limit" });
    return degraded;
  }

  async readOutput(id, cursor = undefined, maxBytes = 64 * 1024) {
    let session = await this.store.get(id);
    if (!session) throw new BridgeError("session_not_found", "Terminal session not found", 404);
    const alive = await this.isAlive(id);
    session = await this.enforceCaptureReserve(id, session, alive);
    this.telemetry.trackActivity?.();
    const range = await this.outputRange(id, session);
    session = await this.enforceCaptureCeiling(id, session, alive, range);
    const requested = parseCursor(cursor, session);
    let logicalStart = requested.offset;
    let gap = null;
    if (requested.mismatch) {
      gap = { reason: "stream_changed", requestedOffset: requested.offset, earliestOffset: range.earliest };
      logicalStart = range.earliest;
    } else if (logicalStart < range.earliest) {
      gap = { reason: "retention", requestedOffset: logicalStart, earliestOffset: range.earliest };
      logicalStart = range.earliest;
    } else if (logicalStart > range.end) {
      gap = { reason: "cursor_ahead", requestedOffset: logicalStart, earliestOffset: range.earliest };
      logicalStart = range.end;
    }
    const requestedMax = Math.max(1, Math.min(Number(maxBytes) || 64 * 1024, 256 * 1024));
    let physicalStart = logicalStart - range.earliest;
    const available = range.end - logicalStart;
    if (available === 0) {
      return {
        sessionId: id,
        alive,
        state: session.state,
        cursor: encodeCursor(session, logicalStart),
        earliestCursor: encodeCursor(session, range.earliest),
        output: "",
        hasMore: false,
        truncated: false,
        gap,
        capture: {
          state: session.transcriptCaptureState,
          reason: session.transcriptGapReason,
          afterCursor: session.transcriptCaptureState === "DEGRADED" ? encodeCursor(session, range.end) : null,
        },
      };
    }

    const handle = await fs.open(this.store.outputPath(id), "r");
    try {
      const first = Buffer.alloc(Math.min(4, range.physicalSize - physicalStart));
      await handle.read(first, 0, first.length, physicalStart);
      let skipped = 0;
      while (skipped < first.length && (first[skipped] & 0xc0) === 0x80) skipped += 1;
      if (skipped > 0) {
        gap ||= { reason: "utf8_boundary", requestedOffset: logicalStart, earliestOffset: range.earliest };
        logicalStart += skipped;
        physicalStart += skipped;
      }
      const readable = range.end - logicalStart;
      const buffer = Buffer.alloc(Math.min(readable, requestedMax + 3));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, physicalStart);
      const safeLength = utf8SafePrefixLength(buffer.subarray(0, bytesRead), Math.min(requestedMax, bytesRead));
      const nextOffset = logicalStart + safeLength;
      return {
        sessionId: id,
        alive,
        state: session.state,
        cursor: encodeCursor(session, nextOffset),
        earliestCursor: encodeCursor(session, range.earliest),
        output: buffer.subarray(0, safeLength).toString("utf8"),
        hasMore: nextOffset < range.end,
        truncated: nextOffset < range.end,
        gap,
        capture: {
          state: session.transcriptCaptureState,
          reason: session.transcriptGapReason,
          afterCursor: session.transcriptCaptureState === "DEGRADED" ? encodeCursor(session, range.end) : null,
        },
      };
    } finally {
      await handle.close();
    }
  }

  async paste(id, text, enter = false) {
    await this.requireSession(id);
    this.telemetry.trackActivity?.();
    const file = path.join(this.store.sessionDir(id), `input-${crypto.randomUUID()}`);
    const bufferName = `dpb_${crypto.randomUUID().replaceAll("-", "")}`;
    // Keep the submitted text and its terminating carriage return in one tmux
    // buffer. A separate `send-keys Enter` comes from another tmux client and
    // is not ordered with bytes which paste-buffer has queued for the pane.
    // Under backpressure it can overtake the tail of the pasted line.
    // paste-buffer converts LF to CR by default, so the final LF is the Enter.
    await fs.writeFile(file, enter ? `${text}\n` : text, { mode: 0o600 });
    try {
      await this.tmux(["load-buffer", "-b", bufferName, file]);
      await this.tmux(["paste-buffer", "-d", "-b", bufferName, "-t", this.tmuxName(id)]);
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  async fingerprintKey() {
    if (!this.fingerprintKeyPromise) {
      this.fingerprintKeyPromise = (async () => {
        const secretPath = path.join(this.store.dataDir, "operation-fingerprint.key");
        try {
          const handle = await fs.open(secretPath, "wx", 0o600);
          try {
            await handle.writeFile(crypto.randomBytes(32));
          } finally {
            await handle.close();
          }
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        const key = await fs.readFile(secretPath);
        if (key.length !== 32) {
          throw new BridgeError("operation_fingerprint_key_invalid", "Operation fingerprint key is invalid", 503);
        }
        return key;
      })();
    }
    return this.fingerprintKeyPromise;
  }

  async requestFingerprint(command) {
    return crypto.createHmac("sha256", await this.fingerprintKey()).update(command, "utf8").digest("hex");
  }

  publicOperation(operation) {
    if (!operation) return null;
    return {
      operationId: operation.id,
      sessionId: operation.sessionId,
      status: operation.status,
      acceptedAt: operation.acceptedAt,
      startedAt: operation.startedAt,
      completedAt: operation.completedAt,
      exitCode: operation.exitCode,
      outcomeReason: operation.outcomeReason,
    };
  }

  operationState(status) {
    if (status === "SUCCEEDED" || status === "FAILED") return "completed";
    return status.toLowerCase();
  }

  startOperationMonitor(operationId, sessionId) {
    if (this.config.monitorOperations === false || this.operationMonitors.has(operationId)) return;
    const monitor = (async () => {
      while (true) {
        const operation = this.store.getOperation(operationId, sessionId);
        if (!operation || operation.status !== "RUNNING") return;
        let completion;
        try {
          completion = await this.store.readOperationCompletion(sessionId, operationId);
        } catch (error) {
          if (error.code !== "operation_completion_invalid") throw error;
          this.store.updateOperation(operationId, "UNKNOWN", {
            completedAt: new Date().toISOString(),
            outcomeReason: "control_record_invalid",
          });
          return;
        }
        if (completion) {
          this.store.updateOperation(operationId, completion.exitCode === 0 ? "SUCCEEDED" : "FAILED", {
            completedAt: completion.completedAt,
            exitCode: completion.exitCode,
            outcomeReason: completion.exitCode === 0 ? "exit_zero" : "exit_nonzero",
          });
          return;
        }
        if (!(await this.isAlive(sessionId))) {
          this.store.updateOperation(operationId, "UNKNOWN", {
            completedAt: new Date().toISOString(),
            outcomeReason: "session_lost_during_operation",
          });
          return;
        }
        await delay(100);
      }
    })().catch((error) => {
      this.logger.error?.("terminal.operation_monitor_failed", {
        sessionId,
        operationId,
        code: error.code,
      });
    }).finally(() => {
      this.operationMonitors.delete(operationId);
    });
    this.operationMonitors.set(operationId, monitor);
  }

  async operationResponse(operation, { includeOutput = true } = {}) {
    let output = "";
    let cursor = operation.startCursor;
    if (includeOutput) {
      try {
        const result = await this.readOutput(operation.sessionId, operation.startCursor, 256 * 1024);
        output = result.output;
        cursor = result.cursor;
      } catch (error) {
        if (!["session_not_found", "session_not_running"].includes(error.code)) throw error;
      }
    }
    return {
      sessionId: operation.sessionId,
      commandId: operation.id,
      operationId: operation.id,
      status: operation.status,
      state: this.operationState(operation.status),
      exitCode: operation.exitCode,
      cursor,
      output,
      note: ["ACCEPTED", "RUNNING"].includes(operation.status)
        ? "The command is still running; the terminal session remains alive."
        : operation.status === "UNKNOWN"
          ? "The previous outcome is uncertain after interruption; the command was not replayed."
          : undefined,
    };
  }

  async getOperation(sessionId, operationId) {
    if (!SAFE_ID.test(operationId)) throw new BridgeError("invalid_operation_id", "Invalid operation ID");
    const session = await this.store.get(sessionId);
    if (!session) throw new BridgeError("session_not_found", "Terminal session not found", 404);
    const operation = this.store.getOperation(operationId, sessionId);
    if (!operation) throw new BridgeError("operation_not_found", "Managed operation not found", 404);
    return this.publicOperation(operation);
  }

  async runCommand(id, command, waitMs = this.config.commandWaitMs, idempotencyKey = undefined) {
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new BridgeError("invalid_command", "Command must be a non-empty string");
    }
    await this.requireSession(id);
    const operationId = crypto.randomUUID();
    const effectiveKey = idempotencyKey === undefined ? "" : String(idempotencyKey);
    if (!SAFE_IDEMPOTENCY_KEY.test(effectiveKey)) {
      throw new BridgeError(
        "invalid_idempotency_key",
        "Idempotency key must contain 1-128 safe ASCII characters",
      );
    }
    const startCursor = await this.outputSize(id);
    const admitted = this.store.admitOperation({
      id: operationId,
      sessionId: id,
      idempotencyKey: effectiveKey,
      requestFingerprint: await this.requestFingerprint(command),
      acceptedAt: new Date().toISOString(),
      startCursor,
    });
    if (admitted.duplicate) {
      this.logger.info("terminal.command_duplicate", {
        sessionId: id,
        operationId: admitted.operation.id,
        status: admitted.operation.status,
      });
      return this.operationResponse(admitted.operation);
    }

    try {
      await this.store.prepareOperationCompletion(id, operationId);
    } catch (error) {
      this.store.updateOperation(operationId, "FAILED", {
        completedAt: new Date().toISOString(),
        outcomeReason: "control_channel_unavailable",
      });
      throw error;
    }
    const completionPath = this.store.operationCompletionPath(id, operationId);
    const completionPartPath = this.store.operationCompletionPartPath(id, operationId);
    const wrapped = `eval -- ${shellQuote(command)}; __dpb_exit=$?; ( umask 077; printf '%s\\n' "$__dpb_exit" > ${shellQuote(completionPartPath)} && mv -f -- ${shellQuote(completionPartPath)} ${shellQuote(completionPath)} )`;
    const startedAt = new Date().toISOString();
    this.store.updateOperation(operationId, "RUNNING", { startedAt });
    try {
      await this.paste(id, wrapped, true);
    } catch (error) {
      this.store.updateOperation(operationId, "UNKNOWN", {
        completedAt: new Date().toISOString(),
        outcomeReason: "spawn_result_uncertain",
      });
      throw error;
    }
    this.logger.info("terminal.command_started", { sessionId: id, operationId });
    this.startOperationMonitor(operationId, id);

    const deadline = Date.now() + Math.max(0, Math.min(Number(waitMs) || 0, 30000));
    let operation = this.store.getOperation(operationId, id);
    while (operation.status === "RUNNING" && Date.now() < deadline) {
      await delay(100);
      operation = this.store.getOperation(operationId, id);
    }
    const result = await this.readOutput(id, startCursor, 256 * 1024);
    this.logger.info(`terminal.command_${this.operationState(operation.status)}`, {
      sessionId: id,
      operationId,
      status: operation.status,
      exitCode: operation.exitCode,
    });
    return {
      ...(await this.operationResponse(operation, { includeOutput: false })),
      cursor: result.cursor,
      output: result.output,
    };
  }

  async sendInput(id, input, enter = true) {
    if (typeof input !== "string") throw new BridgeError("invalid_input", "Input must be a string");
    await this.paste(id, input, Boolean(enter));
    this.telemetry.trackActivity?.();
    this.logger.info("terminal.input_sent", { sessionId: id, characters: input.length, enter: Boolean(enter) });
    return { sessionId: id, accepted: true };
  }

  async interrupt(id) {
    await this.requireSession(id);
    await this.tmux(["send-keys", "-t", this.tmuxName(id), "C-c"]);
    const operation = this.store.interruptActiveOperation(id);
    this.logger.warn("terminal.interrupted", { sessionId: id, operationId: operation?.id });
    return { sessionId: id, interrupted: true, operation: this.publicOperation(operation) };
  }

  async close(id) {
    const session = await this.store.get(id);
    if (!session) throw new BridgeError("session_not_found", "Terminal session not found", 404);
    if (await this.isAlive(id)) await this.tmux(["kill-session", "-t", this.tmuxName(id)]);
    const closed = await this.store.closeSession(id);
    this.logger.warn("terminal.closed", { sessionId: id, retained: true });
    this.telemetry.track("terminal_closed", {
      durationBucket: durationBucket(Date.now() - new Date(session.createdAt).getTime()),
    });
    return { sessionId: id, closed: true, retained: true, closedAt: closed.closedAt };
  }

  async purge(id) {
    const result = await this.store.purge(id);
    this.logger.warn("terminal.purged", { sessionId: id });
    return result;
  }
}

export { encodeCursor, parseCursor, utf8SafePrefixLength };

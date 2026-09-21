import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BridgeError } from "../../../packages/core/src/errors.js";
import { durationBucket } from "./telemetry.js";

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[a-zA-Z0-9_-]{1,80}$/;

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
  }

  tmuxName(id) {
    if (!SAFE_ID.test(id)) throw new BridgeError("invalid_session_id", "Invalid session ID");
    return `dpb_${id}`;
  }

  async tmux(args, options = {}) {
    try {
      return await execFileAsync(this.config.tmuxBin, args, {
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
      await execFileAsync(this.config.tmuxBin, ["has-session", "-t", this.tmuxName(id)]);
      return true;
    } catch {
      return false;
    }
  }

  async open({ cwd = ".", label = "Terminal" }) {
    const resolvedCwd = this.pathPolicy.resolve(cwd);
    const id = crypto.randomUUID();
    const name = this.tmuxName(id);
    const session = {
      id,
      label: String(label).slice(0, 120),
      cwd: resolvedCwd,
      createdAt: new Date().toISOString(),
      closedAt: null,
    };

    await fs.mkdir(this.store.sessionDir(id), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.store.outputPath(id), "", { mode: 0o600 });
    await this.tmux(["new-session", "-d", "-s", name, "-c", resolvedCwd, "bash", "--noprofile", "--norc"]);
    await this.tmux(["set-option", "-t", name, "history-limit", String(this.config.historyLines)]);
    await this.tmux([
      "pipe-pane",
      "-o",
      "-t",
      name,
      `cat >> ${shellQuote(this.store.outputPath(id))}`,
    ]);
    await this.store.save(session);
    this.telemetry.trackActivity?.();
    this.logger.info("terminal.opened", { sessionId: id, cwd: resolvedCwd });
    this.telemetry.track("terminal_opened");
    return { ...session, alive: true };
  }

  async list() {
    const sessions = await this.store.list();
    return Promise.all(sessions.map(async (session) => ({ ...session, alive: await this.isAlive(session.id) })));
  }

  async requireSession(id) {
    const session = await this.store.get(id);
    if (!session) throw new BridgeError("session_not_found", "Terminal session not found", 404);
    if (!(await this.isAlive(id))) {
      throw new BridgeError("session_not_running", "Terminal session is not running", 409);
    }
    return session;
  }

  async outputSize(id) {
    try {
      const size = (await fs.stat(this.store.outputPath(id))).size;
      if (size >= this.config.sessionOutputWarnBytes && !this.largeOutputWarnings.has(id)) {
        this.largeOutputWarnings.add(id);
        this.logger.warn("terminal.output_retention_warning", { sessionId: id, size });
      }
      return size;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
  }

  async readOutput(id, cursor = 0, maxBytes = 64 * 1024) {
    const session = await this.store.get(id);
    if (!session) throw new BridgeError("session_not_found", "Terminal session not found", 404);
    const alive = await this.isAlive(id);
    this.telemetry.trackActivity?.();
    const size = await this.outputSize(id);
    const safeCursor = Math.max(0, Math.min(Number(cursor) || 0, size));
    const length = Math.max(0, Math.min(Number(maxBytes) || 64 * 1024, 256 * 1024, size - safeCursor));
    if (length === 0) return { sessionId: id, alive, cursor: size, output: "", truncated: false };

    const handle = await fs.open(this.store.outputPath(id), "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, safeCursor);
      return {
        sessionId: id,
        alive,
        cursor: safeCursor + bytesRead,
        output: buffer.subarray(0, bytesRead).toString("utf8"),
        truncated: safeCursor + bytesRead < size,
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
    await fs.writeFile(file, text, { mode: 0o600 });
    try {
      await this.tmux(["load-buffer", "-b", bufferName, file]);
      await this.tmux(["paste-buffer", "-d", "-b", bufferName, "-t", this.tmuxName(id)]);
      if (enter) await this.tmux(["send-keys", "-t", this.tmuxName(id), "Enter"]);
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  async runCommand(id, command, waitMs = this.config.commandWaitMs) {
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new BridgeError("invalid_command", "Command must be a non-empty string");
    }
    await this.requireSession(id);
    const commandId = crypto.randomUUID();
    const marker = `__DPB_DONE_${commandId}`;
    const startCursor = await this.outputSize(id);
    const wrapped = `${command}\n__dpb_exit=$?\nprintf '\\n${marker}:%s\\n' "$__dpb_exit"`;
    await this.paste(id, wrapped, true);
    this.logger.info("terminal.command_started", { sessionId: id, commandId });

    const deadline = Date.now() + Math.max(0, Math.min(Number(waitMs) || 0, 30000));
    let result = await this.readOutput(id, startCursor, 256 * 1024);
    while (!result.output.includes(marker) && Date.now() < deadline) {
      await delay(100);
      result = await this.readOutput(id, startCursor, 256 * 1024);
    }
    const match = result.output.match(new RegExp(`${marker}:(\\d+)`));
    const state = match ? "completed" : "running";
    this.logger.info(`terminal.command_${state}`, { sessionId: id, commandId, exitCode: match ? Number(match[1]) : null });
    return {
      sessionId: id,
      commandId,
      state,
      exitCode: match ? Number(match[1]) : null,
      cursor: result.cursor,
      output: result.output.replace(new RegExp(`\\n?${marker}:\\d+\\r?\\n?`), ""),
      note: state === "running" ? "The command is still running; the terminal session remains alive." : undefined,
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
    this.logger.warn("terminal.interrupted", { sessionId: id });
    return { sessionId: id, interrupted: true };
  }

  async close(id, keepOutput = false) {
    const session = await this.store.get(id);
    if (!session) throw new BridgeError("session_not_found", "Terminal session not found", 404);
    if (await this.isAlive(id)) await this.tmux(["kill-session", "-t", this.tmuxName(id)]);
    await this.store.remove(id, Boolean(keepOutput));
    this.logger.warn("terminal.closed", { sessionId: id, keepOutput: Boolean(keepOutput) });
    this.telemetry.track("terminal_closed", {
      durationBucket: durationBucket(Date.now() - new Date(session.createdAt).getTime()),
    });
    return { sessionId: id, closed: true };
  }
}

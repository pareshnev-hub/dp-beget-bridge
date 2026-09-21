import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BridgeError } from "../../../packages/core/src/errors.js";

const SCHEMA_VERSION = 1;

function operationFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    status: row.status,
    acceptedAt: row.accepted_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    exitCode: row.exit_code,
    outcomeReason: row.outcome_reason,
    startCursor: row.start_cursor,
  };
}

function sessionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    cwd: row.cwd,
    createdAt: row.created_at,
    closedAt: row.closed_at,
  };
}

export class StateStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.sessionsDir = path.join(dataDir, "sessions");
    this.databasePath = path.join(dataDir, "state.sqlite");
    this.migrationMarkerPath = path.join(dataDir, "state.sqlite.migrating");
    this.db = null;
  }

  async init() {
    await fs.mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
    await this.recoverInterruptedMigration();
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    const currentVersion = Number(this.db.prepare("PRAGMA user_version").get().user_version);
    if (currentVersion > SCHEMA_VERSION) {
      this.close();
      throw new BridgeError(
        "state_schema_incompatible",
        `State schema ${currentVersion} is newer than supported schema ${SCHEMA_VERSION}`,
        503,
      );
    }
    if (currentVersion < SCHEMA_VERSION) await this.migrate(currentVersion);
    await this.importLegacySessions();
    await this.reconcileUncertainOperations();
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  async recoverInterruptedMigration() {
    let marker;
    try {
      marker = JSON.parse(await fs.readFile(this.migrationMarkerPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw new BridgeError("state_migration_recovery_failed", "State migration marker is invalid", 503);
    }

    let completed = false;
    try {
      const candidate = new DatabaseSync(this.databasePath);
      const version = Number(candidate.prepare("PRAGMA user_version").get().user_version);
      const integrity = candidate.prepare("PRAGMA integrity_check").get().integrity_check;
      candidate.close();
      completed = version === marker.targetVersion && integrity === "ok";
    } catch {
      completed = false;
    }

    if (!completed) {
      if (marker.backupPath) {
        await fs.copyFile(marker.backupPath, this.databasePath);
      } else {
        await fs.rm(this.databasePath, { force: true });
      }
    }
    await fs.rm(this.migrationMarkerPath, { force: true });
  }

  async migrate(fromVersion) {
    const databaseExists = await fs.stat(this.databasePath).then((stat) => stat.size > 0).catch(() => false);
    const backupPath = databaseExists
      ? path.join(this.dataDir, `state.sqlite.backup-v${fromVersion}`)
      : null;
    if (backupPath) await fs.copyFile(this.databasePath, backupPath);
    await fs.writeFile(this.migrationMarkerPath, `${JSON.stringify({
      fromVersion,
      targetVersion: SCHEMA_VERSION,
      backupPath,
    })}\n`, { mode: 0o600 });

    try {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          cwd TEXT NOT NULL,
          created_at TEXT NOT NULL,
          closed_at TEXT
        ) STRICT;
        CREATE TABLE IF NOT EXISTS operations (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          idempotency_key TEXT NOT NULL,
          request_fingerprint TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('ACCEPTED','RUNNING','SUCCEEDED','FAILED','INTERRUPTED','UNKNOWN')),
          accepted_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          exit_code INTEGER,
          outcome_reason TEXT,
          start_cursor INTEGER NOT NULL DEFAULT 0,
          UNIQUE(session_id, idempotency_key)
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS operations_one_writer
          ON operations(session_id)
          WHERE status IN ('ACCEPTED','RUNNING','UNKNOWN');
        PRAGMA user_version = ${SCHEMA_VERSION};
        COMMIT;
      `);
      await fs.rm(this.migrationMarkerPath, { force: true });
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw new BridgeError("state_migration_failed", "Local state migration failed", 503, {
        fromVersion,
        targetVersion: SCHEMA_VERSION,
      });
    }
  }

  async importLegacySessions() {
    let entries;
    try {
      entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO sessions (id, label, cwd, created_at, closed_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const legacy = JSON.parse(await fs.readFile(this.metadataPath(entry.name), "utf8"));
          insert.run(
            legacy.id,
            String(legacy.label || "Terminal").slice(0, 120),
            String(legacy.cwd || "."),
            legacy.createdAt,
            legacy.closedAt ?? null,
          );
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw new BridgeError("legacy_state_import_failed", "Legacy session state could not be imported safely", 503);
    }
  }

  async reconcileUncertainOperations() {
    const active = this.db.prepare(`
      SELECT * FROM operations WHERE status IN ('ACCEPTED', 'RUNNING')
    `).all().map(operationFromRow);
    for (const operation of active) {
      let completion;
      try {
        completion = await this.readOperationCompletion(operation.sessionId, operation.id);
      } catch (error) {
        if (error.code !== "operation_completion_invalid") throw error;
        this.updateOperation(operation.id, "UNKNOWN", {
          completedAt: new Date().toISOString(),
          outcomeReason: "control_record_invalid",
        });
        continue;
      }
      if (completion) {
        this.updateOperation(operation.id, completion.exitCode === 0 ? "SUCCEEDED" : "FAILED", {
          completedAt: completion.completedAt,
          exitCode: completion.exitCode,
          outcomeReason: completion.exitCode === 0 ? "exit_zero" : "exit_nonzero",
        });
      } else {
        this.updateOperation(operation.id, "UNKNOWN", {
          completedAt: new Date().toISOString(),
          outcomeReason: "session_host_restart",
        });
      }
    }
  }

  sessionDir(id) {
    return path.join(this.sessionsDir, id);
  }

  metadataPath(id) {
    return path.join(this.sessionDir(id), "session.json");
  }

  outputPath(id) {
    return path.join(this.sessionDir(id), "terminal.log");
  }

  operationsDir(id) {
    return path.join(this.sessionDir(id), "operations");
  }

  operationCompletionPath(sessionId, operationId) {
    return path.join(this.operationsDir(sessionId), `${operationId}.exit`);
  }

  operationCompletionPartPath(sessionId, operationId) {
    return `${this.operationCompletionPath(sessionId, operationId)}.part`;
  }

  async prepareOperationCompletion(sessionId, operationId) {
    await fs.mkdir(this.operationsDir(sessionId), { recursive: true, mode: 0o700 });
    await fs.rm(this.operationCompletionPath(sessionId, operationId), { force: true });
    await fs.rm(this.operationCompletionPartPath(sessionId, operationId), { force: true });
  }

  async readOperationCompletion(sessionId, operationId) {
    const completionPath = this.operationCompletionPath(sessionId, operationId);
    try {
      const [raw, stat] = await Promise.all([
        fs.readFile(completionPath, "utf8"),
        fs.stat(completionPath),
      ]);
      if (!/^(0|[1-9]\d{0,2})\n?$/.test(raw)) {
        throw new BridgeError("operation_completion_invalid", "Operation completion record is invalid", 503);
      }
      const exitCode = Number.parseInt(raw, 10);
      if (exitCode > 255) {
        throw new BridgeError("operation_completion_invalid", "Operation completion record is invalid", 503);
      }
      return { exitCode, completedAt: stat.mtime.toISOString() };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(session) {
    const dir = this.sessionDir(session.id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    this.db.prepare(`
      INSERT INTO sessions (id, label, cwd, created_at, closed_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        cwd = excluded.cwd,
        created_at = excluded.created_at,
        closed_at = excluded.closed_at
    `).run(session.id, session.label || "Terminal", session.cwd || ".", session.createdAt, session.closedAt ?? null);
    const destination = this.metadataPath(session.id);
    const temporary = `${destination}.part`;
    await fs.writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, destination);
  }

  async get(id) {
    return sessionFromRow(this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id));
  }

  async list() {
    return this.db.prepare("SELECT * FROM sessions ORDER BY created_at").all().map(sessionFromRow);
  }

  async remove(id, keepOutput = false) {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    if (keepOutput) {
      await fs.rm(this.metadataPath(id), { force: true });
      return;
    }
    await fs.rm(this.sessionDir(id), { recursive: true, force: true });
  }

  admitOperation(operation) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = operationFromRow(this.db.prepare(`
        SELECT * FROM operations WHERE session_id = ? AND idempotency_key = ?
      `).get(operation.sessionId, operation.idempotencyKey));
      if (existing) {
        if (existing.requestFingerprint !== operation.requestFingerprint) {
          throw new BridgeError(
            "idempotency_conflict",
            "The idempotency key is already bound to a different command",
            409,
          );
        }
        this.db.exec("COMMIT");
        return { operation: existing, duplicate: true };
      }

      const active = operationFromRow(this.db.prepare(`
        SELECT * FROM operations
        WHERE session_id = ? AND status IN ('ACCEPTED','RUNNING','UNKNOWN')
        LIMIT 1
      `).get(operation.sessionId));
      if (active) {
        throw new BridgeError("session_busy", "The terminal session already has an active managed operation", 409, {
          operationId: active.id,
          status: active.status,
        });
      }

      this.db.prepare(`
        INSERT INTO operations (
          id, session_id, idempotency_key, request_fingerprint, status,
          accepted_at, started_at, completed_at, exit_code, outcome_reason, start_cursor
        ) VALUES (?, ?, ?, ?, 'ACCEPTED', ?, NULL, NULL, NULL, NULL, ?)
      `).run(
        operation.id,
        operation.sessionId,
        operation.idempotencyKey,
        operation.requestFingerprint,
        operation.acceptedAt,
        operation.startCursor,
      );
      this.db.exec("COMMIT");
      return { operation: this.getOperation(operation.id), duplicate: false };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      if (error instanceof BridgeError) throw error;
      throw new BridgeError("operation_admission_failed", "Managed operation admission failed closed", 503);
    }
  }

  getOperation(id, sessionId = undefined) {
    const row = sessionId === undefined
      ? this.db.prepare("SELECT * FROM operations WHERE id = ?").get(id)
      : this.db.prepare("SELECT * FROM operations WHERE id = ? AND session_id = ?").get(id, sessionId);
    return operationFromRow(row);
  }

  activeOperation(sessionId) {
    return operationFromRow(this.db.prepare(`
      SELECT * FROM operations
      WHERE session_id = ? AND status IN ('ACCEPTED','RUNNING','UNKNOWN')
      LIMIT 1
    `).get(sessionId));
  }

  updateOperation(id, status, fields = {}) {
    if (!["ACCEPTED", "RUNNING", "SUCCEEDED", "FAILED", "INTERRUPTED", "UNKNOWN"].includes(status)) {
      throw new BridgeError("invalid_operation_status", "Invalid managed operation status", 500);
    }
    this.db.prepare(`
      UPDATE operations
      SET status = ?,
          started_at = COALESCE(?, started_at),
          completed_at = COALESCE(?, completed_at),
          exit_code = ?,
          outcome_reason = ?
      WHERE id = ?
    `).run(
      status,
      fields.startedAt ?? null,
      fields.completedAt ?? null,
      fields.exitCode ?? null,
      fields.outcomeReason ?? null,
      id,
    );
    return this.getOperation(id);
  }

  interruptActiveOperation(sessionId, reason = "owner_interrupt") {
    const active = this.activeOperation(sessionId);
    if (!active) return null;
    return this.updateOperation(active.id, "INTERRUPTED", {
      completedAt: new Date().toISOString(),
      outcomeReason: reason,
    });
  }
}

export { SCHEMA_VERSION };

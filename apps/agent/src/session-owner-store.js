import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SESSION_OWNER_SCHEMA_VERSION = 1;

function validId(name, value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

export class SessionOwnerStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "session-owners.sqlite");
    this.db = null;
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.file);
    try {
      this.db.exec("PRAGMA busy_timeout = 5000");
      const version = Number(this.db.prepare("PRAGMA user_version").get().user_version);
      if (version > SESSION_OWNER_SCHEMA_VERSION) {
        throw new Error(`Session owner schema ${version} is newer than supported ${SESSION_OWNER_SCHEMA_VERSION}`);
      }
      if (version === 0) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db.exec(`
            CREATE TABLE session_owners (
              session_id TEXT PRIMARY KEY,
              owner_id TEXT NOT NULL,
              created_at TEXT NOT NULL
            ) STRICT;
            PRAGMA user_version = 1;
            COMMIT;
          `);
        } catch (error) {
          try { this.db.exec("ROLLBACK"); } catch {}
          throw error;
        }
      }
      await fs.chmod(this.file, 0o600);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  get(sessionId) {
    validId("sessionId", sessionId);
    return this.db.prepare("SELECT owner_id FROM session_owners WHERE session_id = ?").get(sessionId)?.owner_id;
  }

  set(sessionId, ownerId) {
    validId("sessionId", sessionId);
    validId("ownerId", ownerId);
    const current = this.get(sessionId);
    if (current && current !== ownerId) throw new Error("Terminal ownership cannot be reassigned");
    if (!current) {
      this.db.prepare(
        "INSERT INTO session_owners (session_id, owner_id, created_at) VALUES (?, ?, ?)",
      ).run(sessionId, ownerId, new Date().toISOString());
    }
    return ownerId;
  }

  delete(sessionId) {
    validId("sessionId", sessionId);
    this.db.prepare("DELETE FROM session_owners WHERE session_id = ?").run(sessionId);
  }

  close() {
    this.db?.close();
    this.db = null;
  }
}

import fs from "node:fs/promises";
import path from "node:path";

export class StateStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.sessionsDir = path.join(dataDir, "sessions");
  }

  async init() {
    await fs.mkdir(this.sessionsDir, { recursive: true, mode: 0o700 });
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

  async save(session) {
    const dir = this.sessionDir(session.id);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const destination = this.metadataPath(session.id);
    const temporary = `${destination}.part`;
    await fs.writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, destination);
  }

  async get(id) {
    try {
      return JSON.parse(await fs.readFile(this.metadataPath(id), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async list() {
    let entries;
    try {
      entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const sessions = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const session = await this.get(entry.name);
      if (session) sessions.push(session);
    }
    return sessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async remove(id, keepOutput = false) {
    if (keepOutput) {
      await fs.rm(this.metadataPath(id), { force: true });
      return;
    }
    await fs.rm(this.sessionDir(id), { recursive: true, force: true });
  }
}

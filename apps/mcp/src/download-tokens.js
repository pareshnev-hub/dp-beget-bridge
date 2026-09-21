import crypto from "node:crypto";

export class DownloadTokenStore {
  constructor({ ttlMs }) {
    this.ttlMs = ttlMs;
    this.tokens = new Map();
  }

  issue(filePath) {
    this.cleanup();
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.ttlMs;
    this.tokens.set(token, { filePath, expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  get(token) {
    this.cleanup();
    const value = this.tokens.get(token);
    if (!value || value.expiresAt <= Date.now()) return null;
    return value;
  }

  cleanup() {
    const now = Date.now();
    for (const [token, value] of this.tokens) {
      if (value.expiresAt <= now) this.tokens.delete(token);
    }
  }
}

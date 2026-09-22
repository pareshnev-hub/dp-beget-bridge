import crypto from "node:crypto";

export class DownloadTokenStore {
  constructor({ ttlMs }) {
    this.ttlMs = ttlMs;
    this.tokens = new Map();
  }

  issue(filePath, { authorization, expiresAt: maximumExpiry } = {}) {
    this.cleanup();
    const token = crypto.randomBytes(32).toString("base64url");
    const requestedExpiry = Date.now() + this.ttlMs;
    const ceiling = Date.parse(maximumExpiry || "");
    const expiresAt = Number.isFinite(ceiling) ? Math.min(requestedExpiry, ceiling) : requestedExpiry;
    this.tokens.set(token, { filePath, expiresAt, authorization });
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

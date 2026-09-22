import { BridgeError } from "../../../packages/core/src/errors.js";

export class AgentClient {
  constructor({ baseUrl, token, attachmentFetcher }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.attachmentFetcher = attachmentFetcher;
  }

  async request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(options.body && !(options.body instanceof ReadableStream) ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
      duplex: options.body instanceof ReadableStream ? "half" : undefined,
    });
    if (!response.ok) {
      const raw = await response.text();
      let error = null;
      try {
        error = JSON.parse(raw).error;
      } catch {}
      if (!error) error = { code: "agent_error", message: raw || `Agent returned ${response.status}` };
      const failure = new Error(error?.message || `Agent returned ${response.status}`);
      failure.code = error?.code || "agent_error";
      failure.status = response.status;
      throw failure;
    }
    return response;
  }

  async json(path, method = "GET", body = undefined) {
    const response = await this.request(path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response.json();
  }

  capabilities() { return this.json("/v1/capabilities"); }
  listSessions() { return this.json("/v1/sessions"); }
  openTerminal(input) { return this.json("/v1/sessions", "POST", input); }
  runCommand(id, input) { return this.json(`/v1/sessions/${encodeURIComponent(id)}/commands`, "POST", input); }
  getOperation(sessionId, operationId) {
    return this.json(
      `/v1/sessions/${encodeURIComponent(sessionId)}/operations/${encodeURIComponent(operationId)}`,
    );
  }
  readOutput(id, cursor, maxBytes) {
    const query = new URLSearchParams({ maxBytes: String(maxBytes || 65536) });
    if (cursor !== undefined && cursor !== null) query.set("cursor", String(cursor));
    return this.json(`/v1/sessions/${encodeURIComponent(id)}/output?${query}`);
  }
  sendInput(id, input) { return this.json(`/v1/sessions/${encodeURIComponent(id)}/input`, "POST", input); }
  interrupt(id) { return this.json(`/v1/sessions/${encodeURIComponent(id)}/interrupt`, "POST"); }
  closeTerminal(id) { return this.json(`/v1/sessions/${encodeURIComponent(id)}`, "DELETE"); }
  purgeTerminal(id) { return this.json(`/v1/sessions/${encodeURIComponent(id)}/purge`, "DELETE"); }
  listFiles(candidate) { return this.json(`/v1/files?path=${encodeURIComponent(candidate)}`); }
  copyPath(input) { return this.json("/v1/files/copy", "POST", input); }
  movePath(input) { return this.json("/v1/files/move", "POST", input); }
  deletePath(candidate, recursive) {
    return this.json(`/v1/files?path=${encodeURIComponent(candidate)}&recursive=${Boolean(recursive)}`, "DELETE");
  }
  downloadPath(candidate, { signal } = {}) {
    return this.request(`/v1/files/content?path=${encodeURIComponent(candidate)}`, { signal });
  }
  async uploadFromUrl(file, destination, overwrite, { signal } = {}) {
    if (!this.attachmentFetcher) {
      throw new BridgeError("attachment_fetch_disabled", "External attachment fetch is disabled", 503);
    }
    const source = await this.attachmentFetcher.fetch(file.download_url, { signal });
    try {
      const query = new URLSearchParams({ path: destination, overwrite: String(Boolean(overwrite)) });
      const response = await this.request(`/v1/files/content?${query}`, {
        method: "PUT",
        body: source.body,
        signal: source.signal,
        headers: { "content-type": file.mime_type || "application/octet-stream" },
      });
      return response.json();
    } finally {
      source.dispose();
    }
  }
}

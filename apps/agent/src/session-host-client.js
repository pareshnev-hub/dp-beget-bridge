import http from "node:http";
import { BridgeError } from "../../../packages/core/src/errors.js";

export class SessionHostClient {
  constructor({ socketPath, host, port }) {
    this.socketPath = socketPath;
    this.host = host;
    this.port = port;
  }

  request(path, method = "GET", body = undefined) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const request = http.request({
        ...(this.socketPath ? { socketPath: this.socketPath } : { host: this.host, port: this.port }),
        path,
        method,
        headers: payload ? {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        } : {},
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            reject(new BridgeError("session_host_invalid_response", "Session Host returned invalid JSON", 502));
            return;
          }
          if ((response.statusCode || 500) >= 400) {
            reject(new BridgeError(
              parsed.error?.code || "session_host_error",
              parsed.error?.message || `Session Host returned ${response.statusCode}`,
              response.statusCode || 502,
            ));
            return;
          }
          resolve(parsed);
        });
      });
      request.on("error", (error) => reject(new BridgeError(
        "session_host_unavailable",
        `Session Host is unavailable: ${error.message}`,
        503,
      )));
      if (payload) request.write(payload);
      request.end();
    });
  }

  list() { return this.request("/v1/sessions").then((result) => result.sessions); }
  open(input) { return this.request("/v1/sessions", "POST", input); }
  runCommand(id, command, waitMs, idempotencyKey) {
    return this.request(`/v1/sessions/${encodeURIComponent(id)}/commands`, "POST", {
      command,
      waitMs,
      idempotencyKey,
    });
  }
  getOperation(sessionId, operationId) {
    return this.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/operations/${encodeURIComponent(operationId)}`,
    );
  }
  readOutput(id, cursor, maxBytes) {
    const query = new URLSearchParams({ maxBytes: String(maxBytes || 65536) });
    if (cursor !== undefined && cursor !== null) query.set("cursor", String(cursor));
    return this.request(`/v1/sessions/${encodeURIComponent(id)}/output?${query}`);
  }
  sendInput(id, input, enter) {
    return this.request(`/v1/sessions/${encodeURIComponent(id)}/input`, "POST", { input, enter });
  }
  interrupt(id) { return this.request(`/v1/sessions/${encodeURIComponent(id)}/interrupt`, "POST"); }
  close(id) { return this.request(`/v1/sessions/${encodeURIComponent(id)}`, "DELETE"); }
  purge(id) { return this.request(`/v1/sessions/${encodeURIComponent(id)}/purge`, "DELETE"); }
}

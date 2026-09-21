import { BridgeError, errorPayload } from "./errors.js";

export async function readJson(request, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw new BridgeError("payload_too_large", "JSON payload is too large", 413);
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BridgeError("invalid_json", "Request body is not valid JSON");
  }
}

export function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

export function sendError(response, error) {
  const status = error instanceof BridgeError ? error.status : 500;
  sendJson(response, status, errorPayload(error));
}

export function requireBearer(request, token) {
  const supplied = request.headers.authorization;
  if (!token || supplied !== `Bearer ${token}`) {
    throw new BridgeError("unauthorized", "Valid agent token required", 401);
  }
}

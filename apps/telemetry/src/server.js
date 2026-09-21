import http from "node:http";
import { validateEvent } from "./schema.js";

async function readBody(request, limit = 8192) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export function createTelemetryServer({ store, logger }) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        send(response, 200, { status: "ok" });
        return;
      }
      if (request.method !== "POST" || url.pathname !== "/api/dp-beget-bridge/events") {
        send(response, 404, { error: "not_found" });
        return;
      }
      const event = validateEvent(await readBody(request));
      await store.record(event);
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
    } catch (error) {
      logger.warn("telemetry.event_rejected", { errorCategory: error.code || "invalid_event" });
      send(response, 400, { error: "invalid_event" });
    }
  });
}

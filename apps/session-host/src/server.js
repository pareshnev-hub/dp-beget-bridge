import http from "node:http";
import { BridgeError } from "../../../packages/core/src/errors.js";
import { readJson, sendError, sendJson } from "../../../packages/core/src/http.js";
import { requestRoute } from "../../../packages/core/src/logger.js";

function routeSession(pathname) {
  const match = pathname.match(/^\/v1\/sessions\/([a-zA-Z0-9_-]+)(?:\/(commands|output|input|interrupt))?$/);
  return match ? { id: match[1], action: match[2] || "session" } : null;
}

export function createSessionHostServer({ sessions, logger }) {
  return http.createServer(async (request, response) => {
    const started = Date.now();
    const url = new URL(request.url, "http://session-host.local");
    const route = requestRoute(url.pathname);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok", product: "DP Beget Bridge Session Host" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/sessions") {
        sendJson(response, 200, { sessions: await sessions.list() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        const body = await readJson(request);
        sendJson(response, 201, await sessions.open({ cwd: body.cwd, label: body.label }));
        return;
      }

      const sessionRoute = routeSession(url.pathname);
      if (sessionRoute) {
        const { id, action } = sessionRoute;
        if (request.method === "POST" && action === "commands") {
          const body = await readJson(request);
          sendJson(response, 200, await sessions.runCommand(id, body.command, body.waitMs));
          return;
        }
        if (request.method === "GET" && action === "output") {
          sendJson(
            response,
            200,
            await sessions.readOutput(id, url.searchParams.get("cursor"), url.searchParams.get("maxBytes")),
          );
          return;
        }
        if (request.method === "POST" && action === "input") {
          const body = await readJson(request);
          sendJson(response, 200, await sessions.sendInput(id, body.input, body.enter));
          return;
        }
        if (request.method === "POST" && action === "interrupt") {
          sendJson(response, 200, await sessions.interrupt(id));
          return;
        }
        if (request.method === "DELETE" && action === "session") {
          sendJson(response, 200, await sessions.close(id, url.searchParams.get("keepOutput") === "true"));
          return;
        }
      }

      throw new BridgeError("not_found", "Route not found", 404);
    } catch (error) {
      logger.error("session_host.request_failed", {
        method: request.method,
        route,
        code: error.code,
      });
      if (!response.headersSent) sendError(response, error);
      else response.destroy(error);
    } finally {
      logger.debug("session_host.request_completed", {
        method: request.method,
        route,
        status: response.statusCode,
        durationMs: Date.now() - started,
      });
    }
  });
}

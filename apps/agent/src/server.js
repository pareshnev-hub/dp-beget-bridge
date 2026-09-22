import http from "node:http";
import path from "node:path";
import { capabilityDocument } from "../../../packages/core/src/contracts.js";
import { BridgeError } from "../../../packages/core/src/errors.js";
import { readJson, requireBearer, sendError, sendJson } from "../../../packages/core/src/http.js";
import { requestRoute } from "../../../packages/core/src/logger.js";

function routeSession(pathname) {
  const match = pathname.match(/^\/v1\/sessions\/([a-zA-Z0-9_-]+)(?:\/(commands|output|input|interrupt|purge))?$/);
  return match ? { id: match[1], action: match[2] || "session" } : null;
}

function routeOperation(pathname) {
  const match = pathname.match(/^\/v1\/sessions\/([a-zA-Z0-9_-]+)\/operations\/([a-zA-Z0-9_-]+)$/);
  return match ? { sessionId: match[1], operationId: match[2] } : null;
}

export function createAgentServer({ config, sessions, files, logger }) {
  return http.createServer(async (request, response) => {
    const started = Date.now();
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const route = requestRoute(url.pathname);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok", product: "DP Beget Bridge", agentId: config.agentId });
        return;
      }
      requireBearer(request, config.token);

      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        sendJson(response, 200, capabilityDocument(config.agentId));
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


      const operationRoute = routeOperation(url.pathname);
      if (request.method === "GET" && operationRoute) {
        sendJson(response, 200, await sessions.getOperation(
          operationRoute.sessionId,
          operationRoute.operationId,
        ));
        return;
      }

      const sessionRoute = routeSession(url.pathname);
      if (sessionRoute) {
        const { id, action } = sessionRoute;
        if (request.method === "POST" && action === "commands") {
          const body = await readJson(request);
          sendJson(response, 200, await sessions.runCommand(
            id,
            body.command,
            body.waitMs,
            body.idempotencyKey,
          ));
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
          sendJson(response, 200, await sessions.close(id));
          return;
        }
        if (request.method === "DELETE" && action === "purge") {
          sendJson(response, 200, await sessions.purge(id));
          return;
        }
      }

      if (request.method === "GET" && url.pathname === "/v1/files") {
        sendJson(response, 200, await files.list(url.searchParams.get("path")));
        return;
      }
      if (request.method === "PUT" && url.pathname === "/v1/files/content") {
        const result = await files.upload(
          request,
          url.searchParams.get("path"),
          url.searchParams.get("overwrite") === "true",
        );
        sendJson(response, 201, result);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/files/content") {
        const candidate = url.searchParams.get("path");
        const stat = await files.stat(candidate);
        files.recordDownload(stat.size);
        const file = files.createReadStream(candidate);
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": stat.size,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file.path))}`,
          "cache-control": "no-store",
        });
        file.stream.on("error", (error) => response.destroy(error));
        file.stream.pipe(response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/files/copy") {
        const body = await readJson(request);
        sendJson(response, 200, await files.copy(body.source, body.destination, body.overwrite));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/files/move") {
        const body = await readJson(request);
        sendJson(response, 200, await files.move(body.source, body.destination, body.overwrite));
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/v1/files") {
        sendJson(
          response,
          200,
          await files.remove(url.searchParams.get("path"), url.searchParams.get("recursive") === "true"),
        );
        return;
      }

      throw new BridgeError("not_found", "Route not found", 404);
    } catch (error) {
      logger.error("agent.request_failed", {
        method: request.method,
        route,
        code: error.code,
      });
      if (!response.headersSent) sendError(response, error);
      else response.destroy(error);
    } finally {
      logger.debug("agent.request_completed", {
        method: request.method,
        route,
        status: response.statusCode,
        durationMs: Date.now() - started,
      });
    }
  });
}

import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { capabilityDocument } from "../../../packages/core/src/contracts.js";
import { BridgeError } from "../../../packages/core/src/errors.js";
import { readJson, sendError, sendJson } from "../../../packages/core/src/http.js";
import { AGENT_CONTEXT_HEADER, verifyAgentContext } from "../../../packages/auth/src/agent-context.js";
import { requestRoute } from "../../../packages/core/src/logger.js";

function routeSession(pathname) {
  const match = pathname.match(/^\/v1\/sessions\/([a-zA-Z0-9_-]+)(?:\/(commands|output|input|interrupt|purge))?$/);
  return match ? { id: match[1], action: match[2] || "session" } : null;
}

function routeOperation(pathname) {
  const match = pathname.match(/^\/v1\/sessions\/([a-zA-Z0-9_-]+)\/operations\/([a-zA-Z0-9_-]+)$/);
  return match ? { sessionId: match[1], operationId: match[2] } : null;
}

function equalToken(actual, expected) {
  const left = Buffer.from(actual || "");
  const right = Buffer.from(expected || "");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authenticateAgentRequest(request, config, requestPath) {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization || "");
  if (!match) throw new BridgeError("unauthorized", "Invalid Agent credential", 401);
  if (equalToken(match[1], config.token)) return { kind: "static", scopes: null };
  if (config.oauthToken && equalToken(match[1], config.oauthToken)) {
    try {
      return verifyAgentContext({
        secret: config.contextSecret,
        value: request.headers[AGENT_CONTEXT_HEADER],
        method: request.method,
        path: requestPath,
      });
    } catch (error) {
      throw new BridgeError(
        error?.code || "invalid_agent_context",
        "OAuth Agent authorization context was not accepted",
        Number.isInteger(error?.status) ? error.status : 401,
      );
    }
  }
  throw new BridgeError("unauthorized", "Invalid Agent credential", 401);
}

function requireScope(authorization, scope) {
  if (authorization.kind === "oauth" && !authorization.scopes.has(scope)) {
    throw new BridgeError("forbidden_scope", `Agent authorization requires ${scope}`, 403);
  }
}

function requireSessionOwner(authorization, sessionOwners, sessionId) {
  if (authorization.kind === "oauth" && sessionOwners.get(sessionId) !== authorization.ownerId) {
    throw new BridgeError("session_owner_mismatch", "Terminal session is not owned by this authorization", 403);
  }
}

export function createAgentServer({ config, sessions, files, logger, sessionOwners = new Map() }) {
  let inFlightRequests = 0;
  return http.createServer(async (request, response) => {
    const started = Date.now();
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const route = requestRoute(url.pathname);
    const tracked = !(request.method === "GET" && url.pathname === "/health");
    if (tracked) inFlightRequests++;
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok", product: "DP Beget Bridge", agentId: config.agentId,
          inFlightRequests });
        return;
      }
      const authorization = authenticateAgentRequest(request, config, `${url.pathname}${url.search}`);

      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        sendJson(response, 200, capabilityDocument(config.agentId));
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/sessions") {
        requireScope(authorization, "terminal:read");
        const listed = await sessions.list();
        const visible = authorization.kind === "oauth"
          ? listed.filter((session) => sessionOwners.get(session.id) === authorization.ownerId)
          : listed;
        sendJson(response, 200, { sessions: visible });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        requireScope(authorization, "terminal:execute");
        const body = await readJson(request);
        const opened = await sessions.open({ cwd: body.cwd, label: body.label });
        if (authorization.kind === "oauth") {
          try {
            sessionOwners.set(opened.id, authorization.ownerId);
          } catch {
            await sessions.close(opened.id).catch(() => {});
            await sessions.purge(opened.id).catch(() => {});
            throw new BridgeError(
              "session_owner_storage_failure",
              "Terminal ownership could not be persisted",
              503,
            );
          }
        }
        sendJson(response, 201, opened);
        return;
      }


      const operationRoute = routeOperation(url.pathname);
      if (request.method === "GET" && operationRoute) {
        requireScope(authorization, "terminal:read");
        requireSessionOwner(authorization, sessionOwners, operationRoute.sessionId);
        sendJson(response, 200, await sessions.getOperation(
          operationRoute.sessionId,
          operationRoute.operationId,
        ));
        return;
      }

      const sessionRoute = routeSession(url.pathname);
      if (sessionRoute) {
        const { id, action } = sessionRoute;
        requireSessionOwner(authorization, sessionOwners, id);
        if (request.method === "POST" && action === "commands") {
          requireScope(authorization, "terminal:execute");
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
          requireScope(authorization, "terminal:read");
          sendJson(
            response,
            200,
            await sessions.readOutput(id, url.searchParams.get("cursor"), url.searchParams.get("maxBytes")),
          );
          return;
        }
        if (request.method === "POST" && action === "input") {
          requireScope(authorization, "terminal:input");
          const body = await readJson(request);
          sendJson(response, 200, await sessions.sendInput(id, body.input, body.enter));
          return;
        }
        if (request.method === "POST" && action === "interrupt") {
          requireScope(authorization, "terminal:input");
          sendJson(response, 200, await sessions.interrupt(id));
          return;
        }
        if (request.method === "DELETE" && action === "session") {
          requireScope(authorization, "terminal:close");
          sendJson(response, 200, await sessions.close(id));
          return;
        }
        if (request.method === "DELETE" && action === "purge") {
          requireScope(authorization, "terminal:close");
          const purged = await sessions.purge(id);
          sessionOwners.delete(id);
          sendJson(response, 200, purged);
          return;
        }
      }

      if (request.method === "GET" && url.pathname === "/v1/files") {
        requireScope(authorization, "files:read");
        sendJson(response, 200, await files.list(url.searchParams.get("path")));
        return;
      }
      if (request.method === "PUT" && url.pathname === "/v1/files/content") {
        requireScope(authorization, "files:write");
        const result = await files.upload(
          request,
          url.searchParams.get("path"),
          url.searchParams.get("overwrite") === "true",
        );
        sendJson(response, 201, result);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/files/metadata") {
        requireScope(authorization, "files:read");
        sendJson(response, 200, await files.metadata(url.searchParams.get("path")));
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/files/content") {
        requireScope(authorization, "files:read");
        const release = files.acquireTransfer("download");
        const downloadAbort = new AbortController();
        const abortDownload = () => {
          if (!downloadAbort.signal.aborted) downloadAbort.abort(new Error("Download client disconnected"));
        };
        request.once("aborted", abortDownload);
        response.once("close", () => {
          if (!response.writableEnded) abortDownload();
        });
        try {
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
          await pipeline(file.stream, response, { signal: downloadAbort.signal });
        } finally {
          release();
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/files/copy") {
        requireScope(authorization, "files:write");
        const body = await readJson(request);
        sendJson(response, 200, await files.copy(body.source, body.destination, body.overwrite));
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/files/move") {
        requireScope(authorization, "files:write");
        const body = await readJson(request);
        sendJson(response, 200, await files.move(body.source, body.destination, body.overwrite));
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/v1/files") {
        requireScope(authorization, "files:delete");
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
      if (tracked) inFlightRequests--;
      logger.debug("agent.request_completed", {
        method: request.method,
        route,
        status: response.statusCode,
        durationMs: Date.now() - started,
      });
    }
  });
}

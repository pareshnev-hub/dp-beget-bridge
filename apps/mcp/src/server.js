import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createBridgeMcpServer } from "./mcp-server.js";
import { requestRoute } from "../../../packages/core/src/logger.js";
import { handleOAuthRoute } from "./oauth-routes.js";
import { isAdmissionPaused } from "../../../packages/core/src/admission-gate.js";

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function authenticate(request, config, oauth) {
  if (config.authMode === "oauth") return oauth?.authenticate(request.headers.authorization);
  if (!config.accessToken) return { kind: "static", scopes: null };
  if (request.headers.authorization === `Bearer ${config.accessToken}`) return { kind: "static", scopes: null };
  return null;
}

export function createMcpHttpServer({ config, agent, downloads, logger, oauth }) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    const route = requestRoute(url.pathname, { mcpPath: config.path });
    const started = Date.now();
    const requestAbort = new AbortController();
    const abortRequest = () => {
      if (!requestAbort.signal.aborted) requestAbort.abort(new Error("MCP client disconnected"));
    };
    request.once("aborted", abortRequest);
    response.once("close", () => {
      if (!response.writableEnded) abortRequest();
    });
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok", product: "DP Beget Bridge" });
        return;
      }
      if (await isAdmissionPaused(config.admissionPausePath)) {
        sendJson(response, 503, { error: { code: "admission_paused", message: "Bridge update in progress" } });
        return;
      }
      if (await handleOAuthRoute({ request, response, url, oauth })) return;
      if (request.method === "GET" && url.pathname.startsWith("/download/")) {
        const token = url.pathname.slice("/download/".length);
        const entry = downloads.get(token);
        if (!entry) {
          sendJson(response, 404, { error: { code: "download_not_found", message: "Download link is invalid or expired" } });
          return;
        }
        const downloadAgent = entry.authorization && agent.withAuthorization
          ? agent.withAuthorization(entry.authorization)
          : agent;
        const upstream = await downloadAgent.downloadPath(entry.filePath, { signal: requestAbort.signal });
        const headers = {
          "content-type": upstream.headers.get("content-type") || "application/octet-stream",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(entry.filePath))}`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        };
        const length = upstream.headers.get("content-length");
        if (length) headers["content-length"] = length;
        response.writeHead(200, headers);
        if (!upstream.body) throw new Error("Agent returned an empty download stream");
        await pipeline(Readable.fromWeb(upstream.body), response, { signal: requestAbort.signal });
        return;
      }
      if (url.pathname !== config.path) {
        sendJson(response, 404, { error: { code: "not_found", message: "Route not found" } });
        return;
      }
      const authorization = authenticate(request, config, oauth);
      if (!authorization) {
        response.setHeader("www-authenticate", oauth ? oauth.challenge() : "Bearer");
        sendJson(response, 401, { error: { code: "unauthorized", message: "Invalid access token" } });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
        return;
      }

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const requestAgent = agent.withAuthorization ? agent.withAuthorization(authorization) : agent;
      const mcp = createBridgeMcpServer({
        agent: requestAgent,
        downloads,
        config,
        requestSignal: requestAbort.signal,
        logger,
        authorization,
      });
      await mcp.connect(transport);
      response.on("close", () => {
        transport.close().catch(() => {});
        mcp.close().catch(() => {});
      });
      await transport.handleRequest(request, response);
    } catch (error) {
      logger.error("mcp.request_failed", { method: request.method, route, code: error.code });
      if (response.destroyed) return;
      if (!response.headersSent) sendJson(response, 500, { error: { code: "internal_error", message: "Internal server error" } });
      else response.destroy(error);
    } finally {
      logger.debug("mcp.request_completed", {
        method: request.method,
        route,
        status: response.statusCode,
        durationMs: Date.now() - started,
      });
    }
  });
}

import http from "node:http";
import path from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createBridgeMcpServer } from "./mcp-server.js";
import { requestRoute } from "../../../packages/core/src/logger.js";

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function bearerMatches(request, expected) {
  if (!expected) return true;
  return request.headers.authorization === `Bearer ${expected}`;
}

export function createMcpHttpServer({ config, agent, downloads, logger }) {
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
      if (request.method === "GET" && url.pathname.startsWith("/download/")) {
        const token = url.pathname.slice("/download/".length);
        const entry = downloads.get(token);
        if (!entry) {
          sendJson(response, 404, { error: { code: "download_not_found", message: "Download link is invalid or expired" } });
          return;
        }
        const upstream = await agent.downloadPath(entry.filePath);
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
        for await (const chunk of upstream.body) response.write(chunk);
        response.end();
        return;
      }
      if (url.pathname !== config.path) {
        sendJson(response, 404, { error: { code: "not_found", message: "Route not found" } });
        return;
      }
      if (!bearerMatches(request, config.accessToken)) {
        response.setHeader("www-authenticate", "Bearer");
        sendJson(response, 401, { error: { code: "unauthorized", message: "Invalid access token" } });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
        return;
      }

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const mcp = createBridgeMcpServer({ agent, downloads, config, requestSignal: requestAbort.signal });
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

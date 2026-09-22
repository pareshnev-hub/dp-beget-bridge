const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const SECRET_KEY = /(authorization|cookie|password|secret|token|api[_-]?key)/i;
const SAFE_FIELDS = new Set([
  "allowedRootCount",
  "characters",
  "code",
  "commandId",
  "direction",
  "durationMs",
  "enter",
  "errorCategory",
  "exitCode",
  "keepOutput",
  "method",
  "operationId",
  "platform",
  "port",
  "recursive",
  "reason",
  "retained",
  "route",
  "sessionId",
  "signal",
  "size",
  "sizeBucket",
  "status",
  "tool",
  "version",
]);

function cleanText(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/(\/download\/)(?!:grant\b)[^/?#\s]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:access_token|refresh_token|token|code|api[_-]?key|password)=)[^&#\s]+/gi, "$1[REDACTED]")
    .slice(0, 160);
}

function clean(value, key = "") {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => clean(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k)]));
  }
  return value;
}

export function sanitizeLogFields(fields = {}) {
  const cleaned = clean(fields);
  return Object.fromEntries(Object.entries(cleaned).flatMap(([key, value]) => {
    if (!SAFE_FIELDS.has(key)) return [];
    if (typeof value === "string") return [[key, cleanText(value)]];
    if (typeof value === "number" && Number.isFinite(value)) return [[key, value]];
    if (typeof value === "boolean" || value === null) return [[key, value]];
    return [];
  }));
}

export function requestRoute(pathname, { mcpPath = "/mcp" } = {}) {
  if (pathname === "/health") return "/health";
  if (pathname === mcpPath) return "/mcp";
  if (pathname.startsWith("/download/")) return "/download/:grant";
  if (pathname === "/v1/capabilities") return "/v1/capabilities";
  if (pathname === "/v1/sessions") return "/v1/sessions";
  if (/^\/v1\/sessions\/[^/]+(?:\/(commands|output|input|interrupt|purge))?$/.test(pathname)) {
    return pathname.replace(/^\/v1\/sessions\/[^/]+/, "/v1/sessions/:sessionId");
  }
  if (/^\/v1\/sessions\/[^/]+\/operations\/[^/]+$/.test(pathname)) {
    return "/v1/sessions/:sessionId/operations/:operationId";
  }
  if ([
    "/v1/files",
    "/v1/files/content",
    "/v1/files/copy",
    "/v1/files/move",
  ].includes(pathname)) return pathname;
  if (pathname === "/api/dp-beget-bridge/events") return pathname;
  return "/unmatched";
}

export function createLogger(
  component,
  level = process.env.DP_LOG_LEVEL || "info",
  streams = { stdout: process.stdout, stderr: process.stderr },
) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(logLevel, event, fields = {}) {
    if (LEVELS[logLevel] < threshold) return;
    const record = {
      timestamp: new Date().toISOString(),
      level: logLevel,
      component: cleanText(component),
      event: cleanText(event),
      ...sanitizeLogFields(fields),
    };
    const stream = logLevel === "error" ? streams.stderr : streams.stdout;
    stream.write(`${JSON.stringify(record)}\n`);
  }

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

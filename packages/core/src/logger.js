const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const SECRET_KEY = /(authorization|cookie|password|secret|token|api[_-]?key)/i;

function clean(value, key = "") {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => clean(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k)]));
  }
  return value;
}

export function createLogger(component, level = process.env.DP_LOG_LEVEL || "info") {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(logLevel, event, fields = {}) {
    if (LEVELS[logLevel] < threshold) return;
    const record = clean({
      timestamp: new Date().toISOString(),
      level: logLevel,
      component,
      event,
      ...fields,
    });
    const stream = logLevel === "error" ? process.stderr : process.stdout;
    stream.write(`${JSON.stringify(record)}\n`);
  }

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

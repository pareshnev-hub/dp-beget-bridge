const DATABASES = Object.freeze([
  ["dp-beget-session-host.service", "session-host", "/var/lib/dp-beget-bridge/state.sqlite"],
  ["dp-beget-agent.service", "agent", "/var/lib/dp-beget-bridge-agent/session-owners.sqlite"],
  ["dp-beget-mcp-oauth-spike.service", "oauth", "/var/lib/dp-beget-bridge-mcp/auth/auth.sqlite"]
]);

export function boundDatabases(report) {
  const entries = report?.bindings?.databases;
  if (!Array.isArray(entries) || entries.length !== DATABASES.length ||
      DATABASES.some(([unit, , database], index) => entries[index]?.unit !== unit ||
        entries[index]?.database !== database || !Number.isSafeInteger(entries[index]?.size) ||
        entries[index].size < 0)) {
    throw new Error("Live R0003 database bindings do not match the migration inventory");
  }
  return DATABASES.map(([, name, source]) => ({ name, source }));
}

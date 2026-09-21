# Product telemetry

Telemetry is a separate best-effort channel. It never participates in command
execution or file transfer. Existing installations continue working when the
telemetry endpoint or DP website is unavailable.

## Consent

Telemetry is disabled by default in source builds. The guided installer asks
one explicit question and writes `DP_TELEMETRY_ENABLED=true` only after
consent. It can be disabled at any time without reinstalling.

## Events

| Event | Fields |
|---|---|
| `service_started` | DP version, operating-system family, CPU architecture |
| `active_day` | anonymous installation ID, at most once per running process/day |
| `terminal_opened` | event only |
| `terminal_closed` | duration bucket, not exact command count |
| `file_transferred` | direction and size bucket |

Every event contains schema version, a random installation UUID, and event
time. The collector must discard the source IP after abuse checks and may keep
only a coarse server-region aggregate. A Beget VPS IP describes the hosting
location, not the human user's country.

## Never collected

- commands or terminal output;
- file content, path, or filename;
- server hostname, MCP URL, tokens, cookies, or credentials;
- ChatGPT conversation identifiers;
- the user's name, email, or country unless they voluntarily submit a separate
  feedback/profile form.

The allowlist is enforced in code, so adding an arbitrary field at a call site
does not transmit it. Any new event or field requires a schema change,
documentation update, and release note.

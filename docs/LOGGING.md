# Logging and continuity

DP Beget Bridge separates operational logging from terminal continuity.

## Operational log

Agent and MCP services write structured JSON lines to stdout/stderr. Under
systemd these records are managed by journald. Records include component,
event, severity, duration, session identifier, and error code. They do not
include command text, terminal output, file content, bearer tokens, cookies,
passwords, raw request URLs, download grants, query strings, filenames or
filesystem paths. Request logs use fixed route templates, and exception text
is reduced to a bounded error category rather than copied into records.

The production Caddy example intentionally discards access logs because a
download grant is carried in the URL path. Operators must not enable raw
access logging for this virtual host without an equivalent URI redaction
filter and canary verification.

`DP_LOG_LEVEL` supports `debug`, `info`, `warn`, and `error`. `info` is the
default. Debug mode is opt-in and uses the same field allowlist.

## Terminal continuity log

Each terminal has a local append-only output file on the user's VPS. A versioned
stream/epoch/absolute-byte cursor lets each reader independently retrieve later
output without consuming it for another reader. See `TRANSCRIPT_CURSOR.md`.
The output is not sent to the DP website or telemetry collector. Direct mode
has no central command service.

Rotating or truncating old output does not terminate the `tmux` session. Log
retention and live process lifetime are deliberately independent.

`DP_SESSION_OUTPUT_WARN_BYTES` emits a size warning without deleting data.
`DP_STORAGE_MIN_FREE_BYTES` reserves local disk space: below the threshold,
capture becomes explicitly `DEGRADED` while the tmux process remains under
control. Segmented quotas and capture resumption are completed under DP-010.

## Development and release records

- `CHANGELOG.md` records user-visible changes.
- `docs/ROADMAP.md` is the editable plan and is not a frozen contract.
- every release receives a Git tag and release notes;
- deployment instructions record the exact commit deployed;
- every deployment includes a rollback procedure.

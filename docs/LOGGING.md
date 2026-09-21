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

Each terminal has a local append-only output file on the user's VPS. A byte
cursor lets a later tool call or chat retrieve only output not seen before.
The output is not sent to the DP website or telemetry collector. Direct mode
has no central command service.

Rotating or truncating old output does not terminate the `tmux` session. Log
retention and live process lifetime are deliberately independent.

RELEASE 0001 emits a warning when a transcript reaches
`DP_SESSION_OUTPUT_WARN_BYTES`; it does not delete data automatically. Safe
segmented retention is planned for RELEASE 0002.

## Development and release records

- `CHANGELOG.md` records user-visible changes.
- `docs/ROADMAP.md` is the editable plan and is not a frozen contract.
- every release receives a Git tag and release notes;
- deployment instructions record the exact commit deployed;
- every deployment includes a rollback procedure.

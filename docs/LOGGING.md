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

`node scripts/doctor.mjs --json` emits a small machine-readable local health
report. Each health and systemd probe has a timeout; failed probes expose only
bounded error categories. It identifies a managed release by its version and
commit in the local `current` pointer, checks the Session Host SQLite schema
version read-only, and reports whether the default local disk reserve remains.
`DP_DOCTOR_RELEASE_ROOT`, `DP_DOCTOR_STATE_DATABASE`, `DP_DOCTOR_STATE_DIR`,
and `DP_DOCTOR_MIN_FREE_BYTES`
can select other local installation paths without printing those paths. These
observations do not verify an artifact signature or prove SQLite integrity.
The report contains no environment values, endpoint URLs, tokens, terminal
contents, or filesystem paths. It does not yet provide cross-service request
correlation or a support bundle.

## Terminal continuity log

Each terminal has a local append-only output file on the user's VPS. A versioned
stream/epoch/absolute-byte cursor lets each reader independently retrieve later
output without consuming it for another reader. See `TRANSCRIPT_CURSOR.md`.
The output is not sent to the DP website or telemetry collector. Direct mode
has no central command service.

Rotating or truncating old output does not terminate the `tmux` session. Log
retention and live process lifetime are deliberately independent.

`DP_SESSION_OUTPUT_WARN_BYTES` emits a size warning without deleting data.
`DP_SESSION_OUTPUT_MAX_BYTES` caps captured transcript bytes per terminal; reaching
the cap reports `DEGRADED / transcript_limit` and does not kill the terminal.
`DP_STORAGE_MIN_FREE_BYTES` reserves local disk space: below the threshold,
capture becomes explicitly `DEGRADED` while the tmux process remains under
control. The same reserve rejects new file writes, and
`DP_FILE_TRANSFER_MAX_CONCURRENT` bounds aggregate Agent uploads/downloads.

## Development and release records

- `CHANGELOG.md` records user-visible changes.
- `docs/ROADMAP.md` is the editable plan and is not a frozen contract.
- every release receives a Git tag and release notes;
- deployment instructions record the exact commit deployed;
- every deployment includes a rollback procedure.

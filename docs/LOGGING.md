# Logging and continuity

DP Beget Bridge separates operational logging from terminal continuity.

## Operational log

Agent and MCP services write structured JSON lines to stdout/stderr. Under
systemd these records are managed by journald. Records include component,
event, severity, duration, session identifier, and error code. They do not
include command text, terminal output, file content, bearer tokens, cookies,
or passwords.

`DP_LOG_LEVEL` supports `debug`, `info`, `warn`, and `error`. `info` is the
default. Debug mode is opt-in.

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

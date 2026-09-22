# Transcript cursor contract

DP-008 keeps terminal transcript bytes as local files and stores stream metadata in SQLite schema v2.

## Cursor

The canonical cursor is an opaque string:

`v1:<stream-id>:<epoch>:<absolute-byte-offset>`

Clients must return the cursor received from the previous read. Numeric byte offsets remain accepted during the private-preview compatibility window, but new clients must use the versioned cursor. Readers are stateless and independent; reading never consumes output for another reader.

Every read returns:

- `cursor` — the next versioned cursor;
- `earliestCursor` — the first byte still retained;
- `output` — UTF-8 text ending only at a complete character boundary;
- `hasMore` and the compatibility alias `truncated`;
- `gap` — `null` or an explicit `retention`, `cursor_ahead`, `stream_changed`, or `utf8_boundary` record;
- `capture` — `ACTIVE`, `STOPPED`, or `DEGRADED`, with a bounded reason and the cursor after which capture is uncertain.

A stale cursor is never silently clamped. The response identifies the gap and supplies the earliest/current safe cursor.

## Close and purge

`close_terminal` terminates the tmux session but retains CLOSED metadata and transcript bytes. CLOSED output remains readable after Agent, MCP, or Session Host restart.

`purge_terminal` is the separate destructive operation. It is accepted only for a CLOSED session and permanently removes its metadata, operation rows, transcript, and control records.

## Capture ceiling and storage reserve

`DP_SESSION_OUTPUT_MAX_BYTES` defaults to 64 MiB per terminal. The tmux pipe enforces the byte ceiling independently of API readers. When the ceiling is observed, Session Host records `DEGRADED / transcript_limit` and leaves the terminal process running and controllable.

`DP_STORAGE_MIN_FREE_BYTES` defaults to 256 MiB. If available storage falls below the reserve, Session Host detaches transcript capture from that terminal without killing the terminal process, records `DEGRADED / storage_reserve`, and exposes the uncertain tail through `capture.afterCursor`. Capture does not silently resume because that would hide the missing interval; a future segmented-retention design may add an explicit new epoch.

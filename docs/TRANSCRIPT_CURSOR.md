# Transcript cursor contract

DP-008 keeps terminal transcript bytes as local files and stores stream metadata in SQLite schema v2.

R0004 captures new terminal output in a `terminal.log` first segment followed by numbered private siblings (8 MiB per segment by default). Each already-segmented session retains its original segment size after the configuration changes. The cursor remains one absolute byte offset across the files; a UTF-8 character spanning two files is read whole. Older single-file transcripts remain readable. Segments are retained when a session closes and removed only through explicit purge; no automatic archive or age-based deletion is implied.

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

For an offline copy, a VPS owner with local access to the Session Host state can run
`node scripts/archive-terminal.mjs archive --data-dir /var/lib/dp-beget-bridge --session-id SESSION_ID --output-dir NEW_PRIVATE_DIRECTORY`.
The new directory contains a private copy of the transcript segments and a small
manifest with the byte cursor identity, sizes and SHA-256 checksums. Check the copy
with `node scripts/archive-terminal.mjs verify --archive-dir ARCHIVE_DIRECTORY`
before considering a separate explicit purge. Only CLOSED terminals can be copied.
Archiving preserves the live transcript and metadata and does not change Session
Host's quota; the separate copy occupies disk space, is plaintext and must remain
under owner-only filesystem permissions. After a purge, the archive is available
offline through its files and manifest, not through `read_terminal`. Checksums
detect accidental damage, but do not authenticate a copy against a malicious
local owner. There is no automatic age-based retention or deletion policy yet.

## Capture ceiling and storage reserve

`DP_SESSION_OUTPUT_MAX_BYTES` defaults to 64 MiB per terminal. The tmux pipe enforces the byte ceiling independently of API readers. When the ceiling is observed, Session Host records `DEGRADED / transcript_limit` and leaves the terminal process running and controllable.

`DP_STORAGE_MIN_FREE_BYTES` defaults to 256 MiB. The independent capture pipe checks this reserve before each write, even without an API reader, and persists a small private stop marker if a write would breach it. Session Host also checks available space when reading output and reports `DEGRADED / storage_reserve`, including a stop that occurred while no client was connected; the terminal process keeps running. The uncertain tail is exposed through `capture.afterCursor`. Capture does not silently resume because that would hide the missing interval; a future segmented-retention design may add an explicit new epoch.

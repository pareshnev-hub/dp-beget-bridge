# Resource limits

DP-010 bounds file streaming, transcript capture and the production systemd profile. These limits protect the bridge and the VPS; they do not provide resumable large transfers.

## File paths

- `DP_FILE_UPLOAD_MAX_BYTES` defaults to 512 MiB per upload.
- `DP_FILE_TRANSFER_MAX_CONCURRENT` defaults to 2 aggregate Agent uploads/downloads. Excess admission fails with `transfer_busy` / HTTP 429 rather than forming an unbounded queue.
- `DP_STORAGE_MIN_FREE_BYTES` defaults to 256 MiB. Upload and copy admission preserve this reserve and fail with `storage_reserve` / HTTP 507.
- Downloads use backpressure-aware pipelines at both Agent→MCP and MCP→client hops. A downstream disconnect aborts and closes upstream work.
- External attachment fetch retains its separate 64 MiB, deadline, redirect, concurrency and SSRF limits.

## Terminal capture

- `DP_SESSION_OUTPUT_MAX_BYTES` defaults to 64 MiB per terminal transcript.
- `DP_SESSION_OUTPUT_WARN_BYTES` defaults to 50 MiB and emits one sanitized warning.
- The tmux capture pipe enforces the byte ceiling without requiring an API reader.
- Reaching the ceiling reports `DEGRADED / transcript_limit`; low free space reports `DEGRADED / storage_reserve`.
- Capture degradation never silently kills the tmux terminal. The uncertain tail is explicit in the cursor response.

## Production service profile

The supplied systemd units enforce `TasksMax`, `LimitNOFILE`, `MemoryMax`, `MemorySwapMax` and `NoNewPrivileges`. The Session Host has the larger task/memory allowance because its cgroup owns tmux work. Operators may lower limits after workload measurement; increasing them changes the protection envelope and should be documented.

Resource logs contain only bounded categories and counts. They do not include file names, paths, commands, transcript bytes or credentials.

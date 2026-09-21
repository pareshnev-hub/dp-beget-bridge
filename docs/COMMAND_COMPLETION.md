# Authoritative command completion

DP-007 separates managed-operation status from the PTY transcript. Terminal bytes are user-visible output only and are never completion evidence.

## Control contract

1. Session Host admits the operation to the SQLite ledger before sending input to tmux.
2. It creates a private `operations/` directory inside the session state directory and removes stale files for the new operation ID.
3. The submitted command and its completion suffix are dispatched as one shell input line. This prevents readline/TTY type-ahead flushing from discarding the suffix after sustained output.
4. The submitted command is evaluated by the session shell. If that shell expression returns, the suffix writes its numeric exit code to `<operation-id>.exit.part` with `umask 077` and atomically renames it to `<operation-id>.exit`.
5. Session Host accepts only a complete decimal exit code from 0 through 255. It persists `SUCCEEDED` for zero and `FAILED` for nonzero.
6. A missing record never implies success. Session loss produces `UNKNOWN`; an invalid record fails closed to `UNKNOWN`.

The SQLite operation row remains the public status source. The exit record is private reconciliation evidence and is not exposed through Agent or MCP APIs.

## Shell semantics

- `exec` and `exit` may terminate the shell before it can publish completion. The result is `UNKNOWN`, never fabricated success.
- A foreground interactive program keeps the operation `RUNNING` until it returns or the session is interrupted/lost.
- A background job follows shell semantics: the managed expression may return before the descendant finishes. This bridge does not claim descendant-process completion.
- Syntax and ordinary nonzero exits are recorded when control returns to the wrapper.

## Threat boundary

PTY content cannot write a status record merely by matching a marker. Echoed input, hostile program output, more than 256 KiB of output, transcript rotation and transcript deletion do not affect the decision.

The work identity is explicitly trusted to execute arbitrary local commands and is not sandboxed from its own state directory. This mechanism separates the control plane from ordinary PTY bytes; it is not a privilege boundary against a malicious process already running as the work identity. Stronger isolation would require a separate execution supervisor or kernel boundary and is outside DP-007.

## Restart reconciliation

On Session Host startup, each `ACCEPTED` or `RUNNING` operation is reconciled once:

- valid atomic record: persist its exit result;
- invalid record: `UNKNOWN` with `control_record_invalid`;
- no record: `UNKNOWN` with `session_host_restart`.

No uncertain command is replayed automatically. The same idempotency key returns the existing result.

## Compatibility and rollback

DP-007 does not change SQLite schema version 1. The new `operations/*.exit` files are additive:

- N reads N-1 state; active rows without a record become `UNKNOWN`.
- N-1 reads the same database schema and ignores the additive files.
- Rolling back N-1 also rolls back the completion guarantee for newly submitted commands, so first stop Session Host and ensure no operation is `ACCEPTED` or `RUNNING`.
- Preserve `state.sqlite`, session directories and completion records during rollback. Never delete evidence or replay an `UNKNOWN` command automatically.

## Verification

- TERM-08 prints forged marker-like text and proves the operation remains running until the independent record appears.
- TERM-09 emits more than the maximum single transcript response and proves the nonzero exit remains available.
- Unit coverage also proves status after transcript removal, valid-record restart reconciliation and fail-closed invalid records.
- The real-tmux CI smoke covers forged output, large output, interactive input and `exec` session loss; the focused operation test covers `exit` session loss.
- `npm run test:integration:live-completion` reproduces TERM-08/09, transcript removal and `exec` ambiguity against an installed loopback Agent without printing its credential.

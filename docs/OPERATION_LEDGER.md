# Managed operation ledger

DP-006 introduces a local, versioned SQLite ledger for managed terminal commands. It implements ADR-003 without claiming exactly-once shell execution.

## Contract

- Each accepted command receives an operation ID before it is sent to tmux.
- At most one operation in `ACCEPTED`, `RUNNING` or `UNKNOWN` may exist for a session.
- A caller must supply `idempotency_key` to `run_terminal_command`.
- The same key and command returns the existing operation and does not start another process.
- The same key with a different command returns `idempotency_conflict`.
- A different command while a writer is active returns `session_busy`.
- If Session Host restarts while an operation is `ACCEPTED` or `RUNNING`, an atomic completion record may finalize it; without valid evidence it becomes `UNKNOWN` and is never replayed automatically.
- `get_terminal_operation` returns identifiers, status, timestamps, exit code and a bounded outcome category. It never returns command text or the protected fingerprint.

The request fingerprint is HMAC-SHA-256 under a local 32-byte key stored with mode `0600`. Raw command text is not stored in the ledger or operational logs.

## State and migration

The state database is `state.sqlite` under the Session Host data directory. Schema version 1 contains session metadata and the operation ledger. Transcript bytes remain files.

Before a schema change, the store writes a migration marker and preserves the prior database as `state.sqlite.backup-v<version>`. DDL runs in an immediate transaction. At the next start, a leftover marker is handled as follows:

1. a complete, integrity-checked target schema is retained;
2. otherwise the recorded backup is restored;
3. migration runs again from the recovered version.

Legacy `sessions/*/session.json` records are imported transactionally and left in place. Unreadable legacy metadata stops startup with `legacy_state_import_failed`; it is not deleted.

An on-disk schema newer than the running code stops startup with `state_schema_incompatible`. Downgrade is not attempted.

## Safe rollback

Do not roll back to code that can write an older or incompatible state schema. Stop services, retain the current database and transcript directory, and restore only a compatibility-proven release/backup. Never resolve `UNKNOWN` by automatically executing the original command again.

## Completion evidence

DP-007 removes terminal output from the completion decision. The shell wrapper atomically publishes a bounded exit record under `sessions/<session-id>/operations/`; Session Host monitors that record and persists the result in SQLite. Marker-like bytes in the transcript, transcript truncation and transcript deletion cannot complete or change an operation.

If the shell is replaced or exits before it can publish the record, Session Host returns `UNKNOWN` after observing session loss. An interactive foreground program remains `RUNNING`. A background job is governed by normal shell semantics: completion means that the submitted shell expression returned, not that every descendant process exited.

The detailed control-channel, compatibility and rollback contract is in `COMMAND_COMPLETION.md`.

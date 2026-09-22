# Migration and continuity

## State schema v1 to v2

DP-008 adds transcript stream identity, epoch, earliest retained offset and capture state to session metadata. Migration creates `state.sqlite.backup-v1`, assigns a stable stream identity to every existing session and leaves every `terminal.log` byte unchanged. Schema v2 is not downgrade-compatible with a schema-v1 Session Host; rollback must restore both the previous code and the migration backup. Closing a terminal no longer purges it: retained CLOSED data is removed only through the explicit purge operation.

## Single-user preview to separated runtime identities

DP-009 changes the production layout from one shared runtime user/configuration to:

- `dp-mcp` for the network-facing MCP process;
- `dp-agent` for local policy and file capability enforcement;
- the explicitly selected `--user` / `--work-user` for Session Host, tmux and shell processes.

The installer defaults to `--live-session-policy preserve`. During an update it first stops Agent/MCP admission, checks the durable ledger, and refuses the update if any operation is still `ACCEPTED` or `RUNNING`. A missing, incompatible or unreadable ledger also fails closed. When the preflight passes, the installer stops and starts Session Host so the newly installed JavaScript is actually loaded, waits for its Unix-socket health endpoint, and only then restarts Agent/MCP. The Session Host unit uses `KillMode=process`, so its managed tmux server and idle terminal sessions remain alive across this activation. `UNKNOWN` is a terminal ledger outcome and does not prevent activation; it is never replayed.

On the first migration, legacy tmux cannot be preserved safely because its process environment may contain the former shared credentials. If any legacy tmux session is alive, migration fails before mutation and requires an explicit owner close. With no live legacy session, the stale server is stopped, while `/var/lib/dp-beget-bridge` metadata/transcripts remain in place for the new Session Host. If an update fails after API admission is stopped, the installer makes a best-effort local service restoration and still returns failure.

Credentials are split into root-owned files:

- `/etc/dp-beget-bridge/mcp.env` — readable by `dp-mcp`;
- `/etc/dp-beget-bridge/agent.env` — readable by `dp-agent`;
- `/etc/dp-beget-bridge/session-host.env` — contains paths and limits, but no Agent/MCP credentials.

The legacy `bridge.env` is retained as `root:root 0600` rollback material. The work identity must fail read checks against it and both service credential files. An existing telemetry installation ID is copied non-destructively into the Agent-owned state directory so identity separation does not create a false new installation. The installer refuses any live-session policy other than `preserve`; destructive stop/uninstall behavior is not implicit.

Rollback to the shared-identity preview is a manual owner action: stop the three API services, restore the previous code/unit files and root-only legacy configuration, then restart Agent/MCP under the former work identity. Do not kill the explicit tmux server during rollback. If ownership, state or socket preflight fails, leave the session state in place and stop rather than deleting it.

## User moves to another Beget VPS

1. Install the same or newer DP version on the new VPS.
2. Copy only DP configuration and desired local session transcripts; never
   reuse an exposed token.
3. Issue new agent/MCP credentials.
4. Point the user's own connector hostname to the new VPS and wait for TLS.
5. Run health/capability checks, then retire the old VPS.

The public DP website is not involved. If the user keeps the same hostname,
the connector configuration does not change. Running processes cannot migrate
between kernels; finish or restart those jobs during the cutover.

## DP moves its website or optional relay

Public hostnames remain stable. New infrastructure runs in parallel, health
checks pass, state is exported in a versioned format, DNS is cut over with a
low TTL, and the old service remains available during rollback. Direct-mode
users are unaffected except for optional telemetry, update checks, and docs.

## Compatibility rules

- capability additions are backward-compatible;
- removals require a major protocol version;
- old agents receive a documented support window;
- no deployment mutates terminal state;
- rollback artifacts and release checksums are retained.

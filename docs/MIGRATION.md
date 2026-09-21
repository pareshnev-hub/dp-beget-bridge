# Migration and continuity

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

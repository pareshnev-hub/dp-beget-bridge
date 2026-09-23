# R0004 first-migration transaction — design gate

Status: **DESIGN, NOT DEPLOYABLE** (2026-09-23). The running Beget code is R0003. Its public OAuth process uses a separate code root and does **not** implement the R0004 admission flag. No command in this document authorizes changing the live VPS.

## Observed ingress boundary

`dp-beget-oauth-proxy.socket` is loaded and active on `172.18.0.1:8791`; it triggers `dp-beget-oauth-proxy.service`, whose `systemd-socket-proxyd` forwards to `127.0.0.1:8789`. The socket and service are separate from the shared Traefik container. The public OAuth hostname and TLS route work. Before using the socket as the exclusive release gate, verify that the Traefik route for that hostname really targets this listener and that no alternate public route reaches the OAuth process. This route-target evidence is **not yet recorded**.

The private R0002 tunnel is another independent ingress. Its unit must also remain closed during a legacy migration. The Session Host tmux server and retained transcripts remain outside the code root and must never be killed as an implicit update step.

## Transaction sequence

| Phase | Durable action and proof | Traffic/state boundary |
|---|---|---|
| Prepare | Verify production-pinned signature, build dependencies in quarantine, promote inert version, check disk and current systemd layout. Back up the four legacy fragments, OAuth drop-in, dedicated proxy units and tunnel unit. | Existing R0003 remains active. No version pointer or state change. |
| Boot guard | Install and verify scoped systemd conditions on the dedicated proxy socket/service and tunnel so an on-disk transaction marker prevents them restarting after a reboot. Record previous unit files and guard state. | With no marker, routes are still live. Guard must not affect other Traefik routes. |
| Close ingress | Durably write the transaction journal and marker, then stop proxy socket/service and tunnel. Confirm no bridge-specific public ingress remains. | R0003 does not understand the new pause flag; stopping ingress is mandatory. |
| Quiesce | Stop OAuth MCP, base MCP and Agent, wait for their exit, check the durable terminal operation ledger, then stop Session Host with `KillMode=process`. | Prior file transfers must have finished or failed with atomic cleanup. Do not replay UNKNOWN operations. |
| Snapshot | Take one private, synced bundle of split config and all active SQLite stores while writers are stopped. Preserve retained transcripts and old code roots. | Failure leaves old units and code intact and restores only already-stopped services. |
| Switch | Persist journal phase, write managed unit overrides for all four app services, daemon-reload, switch the code pointer, and start Session Host → Agent → base MCP → OAuth with the persistent R0004 pause flag present. | No public ingress yet. A local health check must verify each service and data schema. |
| Release | After local health, remove the boot guard marker; start dedicated OAuth proxy and tunnel while R0004 still returns 503 for non-health requests. Check the intended public OAuth route, then clear the R0004 pause only after the complete health proof. | Record exact version, artifact digest, schema, CI run and endpoint evidence. |

The root-owned transaction journal needs an explicit phase, old and new code identities, unit-file hashes, snapshot path, admission-marker state, active-service set and exact release artifact digest. Each phase must be synced **before** the next externally visible mutation. A recovery process must inspect this journal before any ingress unit is allowed to start after a reboot. A stale activation lock or an incomplete journal is a stop condition, never permission to remove the marker automatically.

The scoped boot-guard drop-ins can now be prepared and checked with `scripts/release/ingress-boot-guard.mjs`. They use `ConditionPathExists=!/var/lib/dp-beget-bridge/migration-incomplete` on the proxy socket, proxy service and dedicated tunnel only. The marker is persistent across reboot. This helper **does not install** the drop-ins or create/remove the marker. A journaled installer must verify that the original units were snapshotted, install and `daemon-reload` the guards, check that systemd loaded each condition, and only then write and sync the marker before closing ingress. Guard conditions by themselves do not close an already-running socket or tunnel.

After the future install and `daemon-reload`, `scripts/release/installed-ingress-guard-preflight.mjs` checks that systemd reports each exact root-owned guard as the sole drop-in for its expected unit fragment. A missing reload, another drop-in or altered guard fails the check. This read-only check cannot establish that ingress is already closed: the socket and tunnel must be explicitly stopped and observed inactive after the persistent marker is synced.

`scripts/release/close-legacy-ingress.mjs` now implements the isolated closure phase without a CLI: it verifies the installed guard and journal-bound unit backup, rechecks legacy service activity, syncs the persistent marker, records `ingress-closed`, stops only the dedicated proxy socket/service and tunnel, and confirms inactivity. A failed stop leaves the marker and journal for recovery. It cannot be used on Beget until the exact public OAuth route has been proven to target this socket exclusively and the full migration installer has a tested recovery path.

`scripts/release/quiesce-legacy-writers.mjs` implements the following isolated phase without a CLI: it checks that all ingress units remain inactive and the marker is trusted, requires an independent bounded proof that accepted R0003 requests have drained, verifies `KillMode=process`, records quiescence intent, then stops OAuth MCP → base MCP → Agent. It checks the terminal operation ledger before stopping Session Host last. Failures retain the marker and journal. The current R0003 health endpoints cannot provide the R0004 admission-drain proof, so the installer still needs a concrete legacy request-drain probe before this phase can run on Beget.

`scripts/release/snapshot-legacy-state.mjs` binds the synced grouped config/SQLite snapshot to the journal only after the backup routine has checked stopped writers before and after copying. Recovery compares the bundle-manifest digest to journal format v4. A changed inner file still needs the full restore verifier before it can be used for rollback. Failure leaves ingress closed and the journal in quiescence intent for inspection.

`scripts/release/stage-managed-unit-overrides.mjs` prepares four root-owned service drop-ins pointing at the versioned `current` link without changing the legacy fragments or OAuth environment file. `scripts/release/installed-managed-unit-preflight.mjs` checks that systemd actually loaded those bindings, rejects any extra drop-in and preserves `KillMode=process` for Session Host. Neither helper installs the files or changes running services. Their installation must be part of the later journaled switch, with the original unit snapshot available for rollback.

`scripts/release/install-managed-overrides.mjs` adds the isolated installation phase without a CLI. It requires a trusted persistent marker, a journal-bound state snapshot, inactive ingress and stopped writers. It compares installed legacy app unit files with their backup, verifies staged overrides, records switch intent, writes and syncs only the four managed drop-ins, reloads systemd, and checks the loaded bindings. Partial failure leaves the marker and journal in place; removing overrides and restoring the old unit view is a separate recovery transaction. The version pointer and services are not switched by this helper.

`scripts/release/migration-journal.mjs` provides a root-only, private, synced phase record for an exact old/new commit, release digest, verified unit-backup manifest digest, grouped-state manifest digest and observed activity of all seven legacy units. Its exclusive transition lock survives interruption and blocks a second writer until recovery has inspected the state. New transactions use journal format v4; v1–v3 were never installed on Beget. This is still a primitive: it does not record marker state or orchestrate the full unit switch and rollback. The installer must recheck activity immediately before ingress closure because services can change after the initial inventory.

`scripts/release/inspect-migration-recovery.mjs` gives a read-only fail-closed classification for an interrupted transition, orphaned marker, missing marker, or incomplete journal. It re-verifies the referenced unit snapshot against its stored digest and never grants permission to open ingress. The installer still needs to verify actual systemd state against the recorded activity before any recovery action.

The systemd-unit snapshot syncs its files, directories and parent before returning. `scripts/release/verify-systemd-unit-backup.mjs` checks its complete private inventory and returns the manifest SHA-256 bound into the new journal. The installer must verify it again before restoring any unit.

## Failure and rollback invariants

| Failure point | Safe recovery target |
|---|---|
| Before ingress closure | Leave R0003 running; remove only unused staging. |
| After ingress closure, before switch | Restore stopped R0003 services from unchanged old code roots; keep ingress closed until local health is proven. |
| After switch, before opening ingress | Stop candidate writers; restore the grouped snapshot and original unit/drop-in bindings while closed; restart old services and verify health; only then reopen dedicated ingress. |
| After opening ingress | Automatic state rewind is **not** allowed: new user actions, token revocations or file changes may have happened. Require a compatibility-checked forward repair or an explicitly reviewed rollback plan that preserves those actions and revoked credentials. |
| After power loss | Persistent boot guard keeps OAuth proxy and tunnel closed. Recovery uses the journal and snapshot to decide roll forward or roll back; it must not assume a restarted process is healthy. |

SQLite restore must account for `-wal`/`-shm` sidecars and ownership of each service's state directory. A multi-file restore without a crash-recoverable journal can leave stores from different phases mixed. The current `restore-state-bundle.mjs` only recreates data in a **new** directory; live state replacement is not implemented. The unit backup includes the four bridge fragments, OAuth drop-in, proxy socket/service and tunnel fragment in the ingress snapshot slice. It does **not** back up a later boot-guard override. No public update or N/N-1 rollback gate is accepted until guard installation/recovery and a disposable systemd migration/failed-update test pass, followed by exact-commit Beget evidence.

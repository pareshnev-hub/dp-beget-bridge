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

## Failure and rollback invariants

| Failure point | Safe recovery target |
|---|---|
| Before ingress closure | Leave R0003 running; remove only unused staging. |
| After ingress closure, before switch | Restore stopped R0003 services from unchanged old code roots; keep ingress closed until local health is proven. |
| After switch, before opening ingress | Stop candidate writers; restore the grouped snapshot and original unit/drop-in bindings while closed; restart old services and verify health; only then reopen dedicated ingress. |
| After opening ingress | Automatic state rewind is **not** allowed: new user actions, token revocations or file changes may have happened. Require a compatibility-checked forward repair or an explicitly reviewed rollback plan that preserves those actions and revoked credentials. |
| After power loss | Persistent boot guard keeps OAuth proxy and tunnel closed. Recovery uses the journal and snapshot to decide roll forward or roll back; it must not assume a restarted process is healthy. |

SQLite restore must account for `-wal`/`-shm` sidecars and ownership of each service's state directory. A multi-file restore without a crash-recoverable journal can leave stores from different phases mixed. The current `restore-state-bundle.mjs` only recreates data in a **new** directory; live state replacement is not implemented. The unit backup includes the four bridge fragments, OAuth drop-in, proxy socket/service and tunnel fragment in the ingress snapshot slice. It does **not** back up a later boot-guard override. No public update or N/N-1 rollback gate is accepted until guard installation/recovery and a disposable systemd migration/failed-update test pass, followed by exact-commit Beget evidence.

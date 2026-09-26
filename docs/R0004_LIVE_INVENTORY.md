# R0004 read-only Beget inventory

Observed: 2026-09-23 through the real-client OAuth full-shell connector as the `dp-preview` work identity; route-target output supplied from a root terminal on 2026-09-26. The purpose-built connector terminals were closed after the checks. No R0004 code, service unit, configuration, key, database or public route was deployed or changed.

## Existing R0003 deployment

| Unit | Active | User | Working directory | Other migration fact |
|---|---|---|---|---|
| `dp-beget-session-host.service` | yes | `dp-preview` | `/opt/dp-beget-bridge` | `KillMode=process` preserves tmux processes |
| `dp-beget-agent.service` | yes | `dp-agent` | `/opt/dp-beget-bridge` | main unit in `/etc/systemd/system` |
| `dp-beget-mcp.service` | yes | `dp-mcp` | `/opt/dp-beget-bridge` | main unit in `/etc/systemd/system` |
| `dp-beget-mcp-oauth-spike.service` | yes | `dp-mcp` | `/opt/dp-beget-bridge-dp012-dcr` | drop-in `10-dp012-dcr.conf` controls the separate code root |
| `dp-beget-tunnel.service` | yes | `dp-tunnel` | `/var/lib/dp-beget-tunnel` | preserve the separate R0002 harness |

Both existing application code roots reported package version `0.1.0`. `/opt/dp-beget-bridge` and the separate OAuth code root are root-owned mode `0755`. The config directory is root-owned mode `0750`; the Session Host, Agent and MCP state directories have distinct owners and mode `0700`. `/opt` and `/var/lib/dp-beget-bridge` share `/dev/vda1`; the observation does **not** establish free space sufficient for an update snapshot.

## Existing OAuth route

The local OAuth discovery endpoint reported issuer `https://bridge-oauth.pareshnev.com`. Its only public A record resolved to `45.12.238.143`, matching the VPS's public IPv4. A TLS connection with SNI and hostname validation succeeded; the certificate reported expiry on 2026-12-21. Public OAuth authorization-server metadata returned HTTP 200 with the same issuer.

These checks validate the **current R0003 OAuth route**, not a completed R0004 install or an approved 1.0 hostname. The R0004 host-preflight module itself was not executed on Beget, because R0004 code is not installed there.

The dedicated `dp-beget-oauth-proxy.socket` was also loaded and active on `172.18.0.1:8791`; it triggers `dp-beget-oauth-proxy.service`, which forwards to `127.0.0.1:8789`. On 2026-09-26, a root read-only grep of `/opt/beget/n8n` reported `/opt/beget/n8n/traefik_dynamic/dp-beget-oauth.yml` with a `Host` rule for `bridge-oauth.pareshnev.com`, service `dp-beget-oauth` and server URL `http://172.18.0.1:8791`. Docker inspection reported `/opt/beget/n8n/traefik_dynamic` mounted at `/dynamic` in `n8n-traefik-1`. This establishes the intended file-provider target in the observed configuration, but the grep did not enumerate Docker-provider labels, every router rule or all alternate public listeners. Exclusive route evidence remains open. See `docs/R0004_MIGRATION_TRANSACTION.md`.

A second root read-only output on 2026-09-26 found only that OAuth rule in the dynamic YAML rule scan. `ss` showed the OAuth process bound to `127.0.0.1:8789`, the dedicated systemd socket to `172.18.0.1:8791`, and Docker's proxy on `0.0.0.0:443` and `[::]:443`. Docker's published-port list showed only `n8n-traefik-1` on 80/443; the other listed containers had no public OAuth port. Docker-provider router labels and the loaded Traefik provider configuration were not included in that output, so this is a point-in-time listener check, not yet exclusive-route authorization.

A further root read-only Docker inspection on 2026-09-26 listed the running containers' Traefik router rules. The published Docker routers used `pareshnev.com`, `www.pareshnev.com`, `mail.pareshnev.com` or `crarojofimo.beget.app`; none named `bridge-oauth.pareshnev.com`. The shared Traefik compose excerpt included `--providers.docker=true` and `--providers.docker.exposedbydefault=false`. Together with the file-provider rule and listener inventory above, this supports one observed public OAuth path through the dedicated socket. The excerpt does not establish the complete running Traefik provider configuration or capture every non-Docker forwarding path. Recheck the loaded provider configuration, file-provider contents, Docker labels and listeners immediately before migration; do not use this historical inventory as a live assertion callback.

## First-migration consequences

1. Preserve the four existing unit fragments, the OAuth drop-in, both old code roots, split environment files and service-owned state before changing the systemd working directories.
2. Keep the active tunnel harness and tmux server outside the bridge code-pointer rollback.
3. Fail closed if the observed unit layout or a drop-in changes before the migration begins; rerun read-only inventory and review the delta.
4. Block external admissions, drain prior requests and durable terminal operations, stop all state writers, take a grouped snapshot, then change code pointers and unit bindings. Keep the pause through readiness checks and any rollback.
5. Verify OAuth and base MCP independently after a restart. Do not infer readiness from one listener.

The legacy-unit snapshot and state-bundle primitives exist, but no first-migration transaction or live Beget rollback proof exists yet. The current R0003 services should continue serving unchanged while that transaction is built and tested.

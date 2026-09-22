# DP-017 private ChatGPT acceptance tunnel

This harness collects actual ChatGPT DP-003 file-contract evidence without opening an inbound port or changing Traefik. It is temporary acceptance infrastructure, not the R0003 production transport. The local MCP server correctly sees the immediate peer, `tunnel-client`; the secure tunnel does not forward a separate ChatGPT host build in `initialize.clientInfo`.

## Trust boundary

- `dp-beget-mcp` continues to listen only on `127.0.0.1:8788` and continues to require its existing bearer.
- `dp-tunnel` can read only `/etc/dp-beget-tunnel`, which contains a dedicated OpenAI runtime key, a dedicated copy of the MCP authorization header, and the non-secret profile. It cannot traverse the existing bridge configuration directory.
- `tunnel-client` sends the static MCP header only to the configured MCP origin. The value is loaded from a protected file and never appears in argv or checked-in YAML.
- The tunnel admin/health surface listens only on `127.0.0.1:8790`.
- The OpenAI connection is outbound HTTPS. No DNS, TLS, firewall, port 80/443 or Traefik change is part of DP-017.

## Pinned upstream

The harness pins official `openai/tunnel-client` `v0.0.14`, git SHA `0f870e50a973fa820d4c409000059e181e8d242b`, and the published SHA-256 for `tunnel-client-v0.0.14-linux-amd64.zip`. `deploy/install-tunnel-harness.sh` verifies the archive and binary version before installation.

## Installation

Create a Platform runtime API key whose principal has Tunnels Read + Use. Do not use an admin key. On the Beget host, run the installer with `--prompt-runtime-key`; paste the key only into its hidden terminal prompt.

The installer runs the upstream `doctor --explain`, enables the bounded service, waits for `/readyz`, and runs `scripts/tunnel-doctor.mjs`. Existing protected keys are preserved on repeat installation.

## Acceptance evidence

With the service healthy:

1. associate the Platform tunnel with the target ChatGPT workspace;
2. create a developer-mode ChatGPT app using Tunnel connection;
3. capture the sanitized immediate MCP peer name and version in the MCP process;
4. verify `tools/list` descriptors and call `list_files`, upload, and download through the real client;
5. record the exact bridge commit, tunnel-client version, systemd limits, loopback listeners and redacted health output.

Never record runtime keys, bearers, cookies, authorization headers, attachment grants or raw user paths.

## Verified evidence — 2026-09-22

- Bridge commit: `41db3063de886a4c85b38f5545df13b6029edc14`.
- Official tunnel client: `0.0.14+0f870e50a973fa820d4c409000059e181e8d242b`.
- Platform tunnel: `tunnel_6ab24ccf943481919a95e9ed3fd8c404`; ChatGPT developer-mode app: `DP Beget Bridge R0002`.
- The first real ChatGPT read-only call invoked `list_files` and reported an empty `/srv/dp-preview-workspace`.
- The real ChatGPT attachment round trip uploaded the 144-byte `dp017-chatgpt-roundtrip.txt` with `overwrite=false`, observed it through `list_files`, invoked `download_file`, and reported matching SHA-256 `a64605eb0b73b65107816c5a2aaa1ea1950122161f1c3bc5be8b82fb5daf2746` plus the expected text prefix.
- Sanitized MCP evidence recorded `mcp.client_initialized` with `platform=tunnel-client` and the pinned version, followed by `mcp.tool_called` for `list_files`; no arguments, paths, bodies, grants or credentials were logged.
- Core and tunnel doctors passed; all four services were `active/running` with zero restarts; only loopback listeners `127.0.0.1:8787`, `:8788` and `:8790` existed.
- No DNS, Traefik, firewall or public-port change was made. This proves R0002 compatibility only and does not satisfy the R0003 production HTTPS/OAuth gate.

## Teardown

Run `deploy/remove-tunnel-harness.sh`, revoke the Platform runtime API key, and delete or disassociate the Platform tunnel. Then prove that ports `8787` and `8788` remain loopback-only and the three core services still pass `scripts/doctor.mjs`.

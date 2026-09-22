# DP-017 private ChatGPT acceptance tunnel

This harness collects the actual ChatGPT `initialize.clientInfo` and DP-003 file-contract evidence without opening an inbound port or changing Traefik. It is temporary acceptance infrastructure, not the R0003 production transport.

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
3. capture the sanitized `initialize.clientInfo.name` and `.version` in the MCP process;
4. verify `tools/list` descriptors and call `list_files`, upload, and download through the real client;
5. record the exact bridge commit, tunnel-client version, systemd limits, loopback listeners and redacted health output.

Never record runtime keys, bearers, cookies, authorization headers, attachment grants or raw user paths.

## Teardown

Run `deploy/remove-tunnel-harness.sh`, revoke the Platform runtime API key, and delete or disassociate the Platform tunnel. Then prove that ports `8787` and `8788` remain loopback-only and the three core services still pass `scripts/doctor.mjs`.

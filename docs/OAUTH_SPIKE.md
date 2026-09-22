# DP-012 — local OAuth compatibility spike

Status: **VERIFIED** for ChatGPT developer-mode read-only interoperability on 2026-09-22. Implementation is [PR #66](https://github.com/pareshnev-hub/dp-beget-bridge/pull/66), merged as `35ec4d8ef3a575d6d4707cb134d8b33d9b02fc76`. [CI run 35768749994](https://github.com/pareshnev-hub/dp-beget-bridge/actions/runs/35768749994) passed test, real tmux and systemd jobs; the staging suite passed 108 tests. Live client evidence is [recorded in ChatGPT](https://chatgpt.com/c/6ab2e2b6-101c-83ed-a092-b0561a671e9f).

Compatibility basis checked on 2026-09-22: the MCP 2026-07-28 authorization specification and OpenAI's plugin authentication guide.

## Boundary

DP-012 tests OAuth discovery, DCR and Authorization Code with PKCE against a real ChatGPT client. The OAuth spike runs on a separate loopback listener and dedicated HTTPS hostname. The existing Secure MCP Tunnel stays on its original listener and bearer. A code merge does not change either installed service.

The staging grant exposes only `files:read`. ChatGPT discovered exactly `get_bridge_status`, `list_files` and `download_file`; a real `list_files` call returned the staging workspace root and three entries without modifying any files. Terminal and mutating tools were absent from the OAuth connection.

This is not the durable owner/grant system. DP-013 adds owner identity, persistent registration independent of approval-secret rotation, consent, scoped grants and policy enforcement. DP-014 adds refresh rotation, revocation and re-pair.

## Registration modes

- **DCR (verified live):** `POST /oauth/register` registers only a public client using ChatGPT's exact `https://chatgpt.com/connector_platform_oauth_redirect` callback, authorization-code response and token authentication method `none`. Invalid callbacks are rejected. The resulting client ID is deterministic across process restarts while the staging approval secret is unchanged.
- **CIMD (implemented; not viable from this VPS in the measured flow):** the only default allowlisted client identifier is `https://chatgpt.com/oauth/client.json`. Fetching it from this Beget VPS returned HTTP 403, so the actual ChatGPT test used DCR. The CIMD path remains for a future environment where the document can be verified. It fetches only the allowlisted HTTPS URL without redirects and bounds the response.
- No registration mode adds shell rights. Registration does not replace owner approval.

## Endpoints

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server`
- `POST /oauth/register`
- `GET /oauth/authorize`
- `POST /oauth/authorize`
- `POST /oauth/token`
- `POST /mcp`

Issuer, resource, audience and redirect checks use exact identifiers. Metadata advertises PKCE S256; requests without the matching S256 verifier fail. An unauthenticated MCP call returns a 401 protected-resource challenge with the `files:read` scope.

## Security and known staging limits

- OAuth mode refuses the legacy static MCP bearer, and requires HTTPS public URL, issuer and resource.
- Authorization transactions, one-use codes and access tokens are random and process-local. A restart invalidates them. Access tokens expire after 10 minutes by default; there is no refresh token or persisted grant in DP-012.
- DCR client ID is derived from the **staging approval secret**. Rotating this secret invalidates the previous client ID; after the observed rotation a new test connector was registered. Do not silently rotate the secret and assume an existing connector can reauthorize.
- Pending transactions are bounded. A failed owner-secret attempt consumes the transaction. Authorization codes are one-use, including a failed exchange.
- The staging form requires a separate 32+ character secret, no-store, CSP, frame denial and no-referrer headers. Never place credentials, tokens, OAuth codes or secret-bearing URLs in evidence, logs or issue bodies.
- No production owner lifecycle, persistent permissions, revocation or full-shell consent is provided here. Do not expand `DP_OAUTH_SCOPES` beyond `files:read` for this spike.

## Staging deployment and rollback

Keep the Secure MCP Tunnel on `127.0.0.1:8788`. The OAuth test process listens on `127.0.0.1:8789` behind a dedicated HTTPS route; port 8789 must not be opened publicly. The OAuth environment file must contain an Agent token but no `DP_MCP_ACCESS_TOKEN`. Its approval secret is separate from Agent, tunnel and legacy MCP credentials.

To disable DP-012, stop the isolated OAuth unit and remove only its dedicated HTTPS route after verifying the main tunnel and Agent remain healthy. Do not replace the production Secure MCP Tunnel with this short-lived staging OAuth flow.

## Acceptance record

1. ChatGPT accepted metadata and registered via DCR; CIMD failed with a measured upstream 403 from this VPS.
2. The user approved only `files:read` on the dedicated owner page. ChatGPT showed the account as Primary.
3. Exactly three read tools were discovered, and a live `list_files` call succeeded.
4. The tested source revision was `6fecc1b09ae18d1b9a2c9b9ade244c56830dcf7e`, merged into `main` as `35ec4d8ef3a575d6d4707cb134d8b33d9b02fc76`.
5. DP-013/DP-014 and the R0003 client/server acceptance gates remain separate work.

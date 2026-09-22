# DP-012 — local OAuth compatibility spike

Status: implementation complete; real ChatGPT client evidence pending.

Compatibility basis checked on 2026-09-22: the MCP 2026-07-28 authorization
specification and OpenAI's current plugin authentication guide.

## Boundary

DP-012 proves the current MCP OAuth discovery and Authorization Code + PKCE
contract without replacing the retained Secure MCP Tunnel. The OAuth spike runs
on a separate loopback listener and public HTTPS route. It never shares a
listener with the legacy tunnel bearer.

This is not the final owner/grant system. DP-013 adds durable owner identity,
consent, scopes and authorization policy. DP-014 adds refresh rotation,
revocation and re-pair.

## Supported client-registration mode

The spike uses Client ID Metadata Documents (CIMD), which is the preferred
current ChatGPT mode. The only default allowlisted client identifier is:

`https://chatgpt.com/oauth/client.json`

The server fetches that exact HTTPS document without redirects, enforces a
bounded response and verifies the stable ChatGPT redirect URI. It accepts only
the public-client token exchange method `none`, protected by PKCE S256. DCR is
not exposed.

Some hosting networks receive a Cloudflare `403` when they fetch the official
ChatGPT CIMD URL. For this staging-only case,
`DP_OAUTH_ALLOW_PINNED_CHATGPT_CIMD_FALLBACK=true` enables a pinned document
only when the allowlisted client is the exact official URL and its fetch
returns exactly `403`. The pinned document permits only the official ChatGPT
connector callback, authorization-code flow and unauthenticated public-client
token exchange. The option defaults to false; every other status and client
continues to fail closed. Remove the exception when direct CIMD fetch succeeds
or before replacing the spike with the durable DP-013 authorization service.

## Endpoints

- `GET /.well-known/oauth-protected-resource`
- `GET /.well-known/oauth-protected-resource/mcp`
- `GET /.well-known/oauth-authorization-server`
- `GET /oauth/authorize`
- `POST /oauth/authorize`
- `POST /oauth/token`
- `POST /mcp`

The public URL, issuer and resource are exact identifiers. Trailing slashes,
different paths, different ports and different host casing are not normalized
during issuer/resource checks.

## Security behavior

- OAuth mode refuses configuration containing the legacy static MCP bearer.
- Public URL, issuer and resource must use HTTPS.
- Authorization transactions, authorization codes and access tokens are
  random, short-lived and memory-only. Restart revokes them.
- Pending authorization transactions are bounded, and a failed owner-secret
  attempt consumes the transaction instead of permitting repeated guesses.
- Authorization codes are one-use and consumed even after a failed exchange.
- PKCE method is fixed to S256.
- The `resource` value must match on authorization, token exchange and MCP use.
- The authorization response includes `iss`, and metadata advertises RFC 9207
  issuer identification.
- The staging approval form requires a separate 32+ character secret and uses
  no-store, CSP, frame denial and no-referrer headers.
- OAuth spike tokens expose only `get_bridge_status`, `list_files` and
  `download_file`. Mutating and terminal tools are not registered for that
  request.
- No refresh token is issued. Refresh/revoke belongs to DP-014.

## Required staging layout

Keep the working tunnel service on `127.0.0.1:8788`. Run the OAuth spike as a
second MCP process, for example on `127.0.0.1:8789`, with a separate environment
file and `DP_MCP_AUTH_MODE=oauth`. Route only the dedicated HTTPS hostname/path
to the OAuth listener. Do not publish port 8789 directly.

The OAuth service needs the existing Agent token but must not receive
`DP_MCP_ACCESS_TOKEN`. Its approval secret is separate from Agent, tunnel and
legacy MCP credentials. The installer asks for that 32+ character secret twice
without echoing it; retain it for the staging owner approval page.

## Acceptance sequence

1. Verify both metadata documents over the final HTTPS origin.
2. Confirm unauthenticated `/mcp` returns `401` with `resource_metadata` and
   `scope="files:read"`.
3. Create a separate ChatGPT test plugin using CIMD and the OAuth HTTPS MCP URL.
4. Enter the staging approval secret in the owner page.
5. Confirm ChatGPT completes PKCE exchange and can call `list_files`.
6. Confirm mutating and terminal tools are absent from the OAuth connection.
7. Record sanitized client/server versions and exact registration mode.
8. Disable the staging public route if DP-013 does not begin immediately.

No DP-012 status becomes DONE until the real ChatGPT flow is recorded against
an exact commit and deployment revision.

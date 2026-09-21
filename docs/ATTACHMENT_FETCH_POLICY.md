# External attachment fetch policy

Status: DP-004 implementation policy  
Policy version: 1  
Date: 2026-09-21

## Default policy

`upload_files` fails closed and accepts only an HTTPS source on the default
port 443 without URL credentials. Before opening a connection, the MCP process
resolves the hostname itself, rejects the entire answer set if any address is
non-public, and pins the selected validated address into the TLS connection.
The original hostname remains the TLS SNI and HTTP Host identity.

Each redirect is handled manually and repeats URL, DNS and IP validation.
There is no unrestricted `fetch` fallback. IPv4 and IPv6 loopback, private,
link-local, multicast, documentation and relevant transition/special-use
ranges are denied. A mixed public/private DNS answer is denied rather than
selecting the apparently safe record.

The source request sends only `Accept: application/octet-stream`. It never
receives the MCP access token, Agent bearer, cookies, or other incoming request
headers. Source-provided MIME metadata is not trusted; absent verified
`mime_type` input is forwarded to the Agent as `application/octet-stream`.

## Resource bounds

| Variable | Default | Meaning |
|---|---:|---|
| `DP_ATTACHMENT_FETCH_ENABLED` | `true` | fail-safe capability switch |
| `DP_ATTACHMENT_FETCH_TIMEOUT_MS` | `120000` | overall DNS, headers and body deadline |
| `DP_ATTACHMENT_MAX_BYTES` | `67108864` | 64 MiB source-body ceiling |
| `DP_ATTACHMENT_MAX_REDIRECTS` | `5` | maximum validated redirect hops |
| `DP_ATTACHMENT_MAX_CONCURRENT` | `2` | active fetch ceiling; excess is rejected, not queued |

The MCP request cancellation signal is combined with the underlying HTTP
connection signal. A client disconnect aborts source download and the Agent
upload; the Agent's atomic temporary-file path remains responsible for cleanup.

## Operations and rollback

Changing the policy values requires an MCP service restart. Existing installs
without the new variables receive the defaults above. No state migration is
required.

If DNS pinning, TLS verification, cancellation, redirect validation or bounds
cannot be enforced, set `DP_ATTACHMENT_FETCH_ENABLED=false` and restart the MCP
service. The upload tool then returns an explicit disabled error; it never falls
back to an unrestricted network request.

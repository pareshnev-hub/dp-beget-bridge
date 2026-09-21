# DP Beget Bridge architecture

## Design rule

The terminal belongs to the user's VPS. It never belongs to an HTTP request,
MCP call, browser window, ChatGPT conversation, or DP website.

## Direct mode (default)

Both services run on the user's Beget VPS:

1. **DP MCP** exposes the HTTPS Streamable HTTP endpoint used by ChatGPT or
   Codex.
2. **DP Agent** listens only on loopback and owns terminal/file capabilities.
3. **tmux** owns the actual shell processes and keeps them alive across MCP,
   browser, and model timeouts.

`pareshnev.com` is not in the command or file path. It provides installation,
documentation, feedback, update metadata, and optional product telemetry. An
outage of that site does not affect an installed bridge.

## Catalog mode (optional future transport)

A catalog plugin must have one fixed MCP URL. Catalog mode therefore requires
a DP relay to route an authenticated user to their agent. It is opt-in and
implements the same `AgentGateway` contract. Direct mode remains available and
does not depend on that relay.

## Extension points

- `AgentGateway`: local HTTP in Direct mode; outbound relay later.
- `Capability`: terminal and files today; Docker, Git, database, backups later.
- `SessionBackend`: `tmux` today; other PTY managers can be added later.
- `StateStore`: JSON files today; SQLite/PostgreSQL adapters later.
- `AuthorizationPolicy`: generated token in developer mode; local OAuth 2.1
  for Direct mode and scoped OAuth grants for Catalog mode.
- `FileTransferBackend`: streamed local transfer today; resumable chunked
  transfer and cross-server copy later.
- `ProductTelemetry`: explicit-consent, allowlisted aggregate events; the
  implementation is isolated from terminal and file data.

## Persistence model

Terminal sessions have no idle expiry. A session ends only when the user (or
an authorised tool call) explicitly closes it, the VPS shuts down, or the
operating system terminates it. MCP request timeouts only stop waiting for
output. They never send a signal to the process.

A physical VPS reboot necessarily terminates operating-system processes. DP
can retain output and metadata, but cannot resurrect an arbitrary process the
kernel already stopped.

## Versioning

Agent and MCP exchange a versioned capability document. New capabilities are
additive. Existing tool names and schemas remain backwards compatible after
publication.

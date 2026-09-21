# DP Beget Bridge

Persistent terminal and file access for Beget VPS from ChatGPT and Codex.

DP Beget Bridge keeps terminal sessions on the server instead of inside a
single model call. Closing a browser tab, switching chats, or timing out an
MCP request does not terminate the shell or the command running inside it.

> Independent open-source project. Not affiliated with Beget.

In Direct mode both DP services run on the user's VPS. Commands and files do
not pass through `pareshnev.com`; the site is only an installation,
documentation, feedback, and optional telemetry entry point.

## RELEASE 0001 scope

- persistent Linux terminal sessions backed by `tmux`;
- reconnect and resume after client or agent disconnects;
- non-destructive output polling with stable cursors;
- interactive input and explicit process/session termination;
- file listing, upload, download, copy, move, and delete;
- a versioned capability contract for future modules;
- an MCP endpoint for ChatGPT and Codex;
- no central storage of terminal transcripts or file data;
- optional allowlisted product telemetry with explicit consent.

## Why sessions do not disappear

The Linux agent creates each terminal in its own `tmux` session. The MCP
server can disconnect at any time without owning or killing that process.
Session metadata is kept on the VPS, and the agent rediscovers running
sessions after it restarts.

A physical VPS reboot necessarily terminates operating-system processes.
After a reboot DP Beget Bridge can recreate the shell and its working
directory, but it cannot resurrect an arbitrary process that the operating
system already stopped.

## Repository layout

- `apps/agent` — Linux terminal and file agent installed on the VPS.
- `apps/mcp` — Streamable HTTP MCP server exposed to ChatGPT and Codex.
- `packages/core` — versioned capability and transport contracts.
- `deploy` — systemd and Beget installation assets.
- `docs` — architecture, security model, releases, and roadmap.

See `docs/TELEMETRY.md` for the exact event allowlist and `docs/MIGRATION.md`
for server moves and continuity rules.

## Development

Requirements: Node.js 22+, npm, and `tmux` for terminal integration tests.

```bash
npm install
cp .env.example .env
npm test
```

Start the local agent and MCP server in separate shells:

```bash
npm run start:agent
npm run start:mcp
```

The current `0.1.0` build is a technical preview using a generated bearer
token. Direct ChatGPT onboarding requires the local OAuth work listed for
RELEASE 0002; do not expose an unauthenticated MCP endpoint to the internet.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.

Privacy details are in `PRIVACY.md`. Voluntary project support, when a payment
destination is selected, is described in `SUPPORT.md` and remains outside the
connector interaction.

# DP Beget Bridge

Persistent terminal and file access for a Linux VPS from ChatGPT and Codex.

DP Beget Bridge keeps terminal sessions on the server instead of inside a single model call. MCP timeout or client disconnect is intended to stop waiting, not terminate the shell/process.

> DP Beget Bridge is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Beget.

## Current status

**0.1.x / RELEASE 0001 is a technical preview. It is not yet the public-ready Direct product.**

A 2026-09-21 architecture/security audit found runtime issues that must be resolved before broader use, including a P0 file-move data-loss case and P1 work around terminal operation lifecycle, file-fetch security, process/credential isolation, transcript/resource controls and real tmux/systemd integration testing.

Start here:
- [Roadmap](docs/ROADMAP.md)
- [Target architecture](docs/ARCHITECTURE.md)
- [Audit](docs/audit/AUDIT-2026-09-21.md)
- [First implementation sprint](docs/audit/FIRST_SPRINT.md)
- [Release acceptance test matrix](docs/audit/TEST_MATRIX.md)
- [Work handoff](docs/audit/GITHUB_HANDOFF.md)
- [Architecture decisions](docs/adr/README.md)

The implementation queue is tracked in GitHub Issues **DP-001…DP-015**. The first implementation task is **DP-001 — Prevent destructive move pre-delete**.

## Product direction

### Direct Mode — primary

The installed Direct connector runs on the user's VPS:

```text
ChatGPT / Codex
      |
      | HTTPS + OAuth
      v
user VPS
      |
      +-- DP MCP / local authorization
      +-- DP Agent / policy
      +-- persistent Session Host / tmux
      +-- file capability
```

Commands, terminal transcripts and file contents are not intended to be centrally stored by DP services.

The DP website, analytics and feedback services are optional and must not be dependencies of an already-installed Direct runtime.

### Catalog Mode — later and optional

A future Catalog integration may use a fixed DP endpoint/Relay if current OpenAI distribution requirements make it necessary. It must reuse the same terminal/file capability core; it is not a second terminal implementation.

Direct remains available independently of Catalog.

## Core principles

- Linux VPS/systemd/tmux is the current platform boundary.
- Terminal sessions belong to the VPS, not to an HTTP/MCP request.
- API/client restart must not silently kill the terminal session.
- Normal runtime is not root-by-default.
- Service credentials must be separated from restricted shell execution.
- Arbitrary shell operations are not falsely advertised as exactly-once across crashes.
- Unsafe file mutation cases are disabled until they can be implemented safely.
- Sensitive session content remains local to the VPS except when intentionally returned to the chosen client.
- Product telemetry is opt-in, coarse and non-blocking.
- Scale is driven by measured load, not speculative Kubernetes/Redis/broker deployment.

## Existing technical-preview components

The repository currently includes:
- `apps/agent` — Linux terminal/file agent;
- `apps/mcp` — Streamable HTTP MCP server;
- `apps/telemetry` — optional telemetry prototype;
- `packages/core` — shared errors/logging/path/contracts;
- `deploy` — systemd and installer foundation;
- `docs` — architecture/security/roadmap;
- `test` — automated tests;
- GitHub Actions CI.

The preview includes tmux-backed sessions, cursor-based terminal output, interactive input, file operations, short-lived download grants and local path-policy controls. These capabilities are being hardened under RELEASE 0002.

## Release path

- **R0002 / proposed 0.2.0:** Core Safety & Persistent Runtime.
- **R0003 / proposed 0.3.0:** Working Direct / Private Beta with local OAuth/consent/revoke and real client E2E.
- **R0004 / 1.0.0:** Public Direct with reproducible install/update/rollback, retention/quotas, documentation and security review.
- **R0005:** Large/resumable transfer hardening.
- **R0006:** Optional Catalog transport pilot, after a current feasibility check.
- **R0007:** Catalog submission/scale based on measured load.

See [ROADMAP.md](docs/ROADMAP.md) for release gates and acceptance criteria.

## Development

Requirements for the current preview: Node.js 22+, npm, and `tmux` for terminal integration work.

```bash
npm install
cp .env.example .env
npm test
```

Start local preview services in separate shells:

```bash
npm run start:agent
npm run start:mcp
```

Do not expose an unauthenticated MCP or Agent endpoint to the public internet.

## Privacy

Direct terminal continuity data is sensitive local data on the VPS. Product analytics must not include terminal commands/output, file bodies, credentials or ChatGPT conversation identifiers.

See:
- [PRIVACY.md](PRIVACY.md)
- [Privacy/telemetry architecture decisions](docs/PRIVACY_DECISIONS.md)

## Release discipline

A green CI build is not automatically a release. Public releases require exact commit identity, acceptance evidence, migrations, immutable verified artifacts and documented rollback.

See [RELEASE_PROCESS.md](docs/RELEASE_PROCESS.md).

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.

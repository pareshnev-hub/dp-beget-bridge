# ROADMAP — DP Beget Bridge

Date: 2026-09-21  
Audit baseline: `f22032ec6c465f0eeffec6c360959d266941ea29`  
Status: **ACCEPTED ROADMAP / SOURCE OF TRUTH**

This roadmap supersedes the preliminary sequence that placed OAuth/installer work ahead of core runtime hardening. GitHub Issues refine the work; they do not replace release acceptance gates.

## Product goal

DP Beget Bridge is a Linux-first bridge that lets ChatGPT/Codex work with a user's VPS terminal and files without permanent copy/paste.

The core product is **Direct Mode**:

```text
ChatGPT / Codex
      |
      | HTTPS + OAuth
      v
user-controlled VPS
      |
      +-- DP MCP
      +-- DP Agent
      +-- persistent Session Host / tmux
      +-- file capability
```

The DP website, analytics, feedback backend and future Catalog Relay are optional services and must not be dependencies of installed Direct Mode.

## Non-negotiable architecture principles

1. **Linux VPS, not Windows remote desktop.** Windows Agent/UAC/NAT-desktop requirements are outside this project's scope.
2. **Session belongs to the VPS.** MCP timeout or network disconnect must not terminate a terminal process.
3. **Control plane and data plane stay distinct.** Auth/grants/metadata are control plane; stdin/stdout/transcript/file bytes are data plane.
4. **Sensitive session content is not centrally stored.** No central storage of commands, terminal output, file bodies, paths, filenames, credentials or ChatGPT conversation identifiers.
5. **Direct stays autonomous.** Existing installations continue operating when pareshnev.com, telemetry, feedback or Catalog services are unavailable.
6. **No root-by-default.** Normal network daemons and execution profiles run with the minimum OS privileges needed.
7. **No false exactly-once claims.** Shell operations use operation IDs/idempotency and expose UNKNOWN when a crash makes outcome uncertain.
8. **No unsafe fallback.** If a file/session operation cannot yet be implemented safely, return unsupported rather than silently weakening security.
9. **Telemetry is opt-in and non-blocking.** It never participates in runtime authorization or execution.
10. **Scale by measured load.** Do not add Redis, brokers, Kubernetes or multi-region infrastructure before the workload needs them.

## Current state

RELEASE 0001 / package 0.1.0 is a **technical preview**, not a public-ready release.

Already present:
- Node.js ESM implementation;
- MCP Streamable HTTP endpoint;
- loopback Agent API;
- tmux sessions;
- terminal output by byte cursor;
- interactive input and explicit close;
- file operations;
- path policy;
- short-lived download grants;
- telemetry prototype;
- systemd templates;
- installer foundation;
- documentation and CI.

GitHub repository is public and the first GitHub Actions CI run on the audit baseline succeeded.

The green unit CI does **not** prove persistence across real tmux/systemd lifecycle events.

## Critical findings that change implementation order

### P0 — destructive move pre-delete
Current move logic may delete the destination before a successful replacement. Same-path and missing-source cases can cause data loss.

**Rule:** this is the first code fix.

### P1 — execution/user isolation
The installer can default to root when invoked from a root shell. Agent/MCP/session execution must not share privileges/secrets in a way that gives shell tasks access to service credentials.

### P1 — incoming file URL / SSRF
File upload currently fetches an externally supplied download URL. The implementation needs HTTPS/DNS/IP/redirect/timeout/size controls and must never forward agent credentials to the source origin.

### P1 — OpenAI file contract mismatch
The MCP file schema/descriptors must be aligned with the actual client contract and tested. Tool annotations must mark overwrite-capable/destructive operations correctly.

### P1 — command completion and concurrency
Completion cannot depend on finding a marker in terminal stdout. One session needs a single-writer operation model with durable operation IDs, idempotency and honest UNKNOWN states.

### P1 — transcript persistence/resource controls
Closed-session metadata must survive when output is retained. Cursor behavior must be explicit across UTF-8 boundaries, rotation/gaps and multiple readers. Disk/memory/output limits are part of safety, not a later optimization.

### P1 — streaming/backpressure
Large transfer paths must preserve backpressure/cancellation and bounded memory.

### P1 — secrets in logs
Request/download tokens and exception text must not leak through debug/error/proxy diagnostics.

## Release sequence

```text
R0001 technical preview
        |
        v
R0002 Core Safety & Persistent Runtime
        |
        v
R0003 Working Direct / Private Beta
        |
        v
R0004 Public Direct 1.0
        |                    |
        v                    v
R0005 Large Transfer     Catalog feasibility gate
Hardening                   |
                             v
                     R0006 Catalog Pilot
                             |
                             v
                     R0007 Submission & Scale
```

## RELEASE 0002 — Core Safety & Persistent Runtime

Proposed version: **0.2.0**  
Status: **PLANNED**

### Goal
Make the existing local vertical slice safe enough to expose to real clients.

### Scope
- Fix destructive move behavior; same-path and missing-source regressions.
- Align MCP file schemas/tool annotations/output contracts.
- Add secure external file-fetch policy and cancellation.
- Protect file mutations from unsafe overwrite/symlink/race behavior; temporarily disable unsupported cases.
- Introduce durable operation ledger and per-session single-writer semantics.
- Separate command completion/status from PTY stdout.
- Preserve CLOSED session metadata and readable retained transcripts.
- Add versioned cursors, UTF-8-safe reading and explicit transcript gaps.
- Add hard ceilings for sessions/output/transfers/disk reserve.
- Separate MCP/Agent/work execution identities and secrets.
- Give the Session Host its own lifecycle ownership and explicit tmux socket.
- Add real tmux/systemd integration tests.
- Sanitize logs/diagnostics and proxy paths.

### State migration
Introduce a versioned local state adapter, targeted at SQLite, for operation/session metadata. Existing transcript files remain files rather than database BLOBs. Legacy state must be imported without deleting source data.

### Definition of Done
- All known P0 issues closed.
- P1 issues in the included runtime either fixed or capability explicitly disabled.
- A long-running command survives MCP and Agent restart on a disposable Linux/systemd host.
- A retry does not accidentally execute the same managed operation twice.
- Shell execution profile cannot read MCP/Agent authorization secrets.
- Known data-loss file cases have regression tests.
- Evidence references exact commit + CI/runtime run.

### Not in R0002
Public OAuth onboarding, polished installer, Relay, large resumable transfers, billing, multi-tenant features.

## RELEASE 0003 — Working Direct / Private Beta

Proposed version: **0.3.0**  
Status: **PLANNED**

### Goal
Complete a real end-to-end client path:

```text
ChatGPT/Codex -> HTTPS/OAuth MCP -> Agent -> Session Host/tmux -> output
                                               |
                                               +-> small file transfer
```

### Scope
- Local OAuth authorization server/provider adapter.
- Discovery + Authorization Code + PKCE S256.
- Correct issuer/resource/audience validation.
- Exact redirect URI policy.
- Client-registration compatibility proven with the actual target client.
- One-time owner bootstrap.
- Human consent for execution profile/scopes.
- Explicit unattended grants with owner/scope/expiry.
- Refresh rotation, reuse detection, revoke/reset/re-pair lifecycle.
- TLS and DNS/proxy preflight for supported deployment matrix.
- Limited setup wizard for a known Linux environment.
- Real ChatGPT/Codex E2E tests.
- Site/telemetry/feedback disconnected during autonomy acceptance test.

### Security rule
A model-supplied `confirmed=true` is never human authorization. Full shell grants must clearly state that shell commands can perform file operations within OS rights regardless of separate file-tool scopes.

### Definition of Done
- Real client can open a persistent terminal, start a task, stop waiting, reconnect and continue reading.
- Revoke blocks new mutations.
- Small upload/download succeeds using the actual client contract.
- Direct keeps working with all central DP services unavailable.

## RELEASE 0004 — Public Direct 1.0

Proposed version: **1.0.0**  
Status: **PLANNED**

### Goal
Turn the private beta into a reproducibly installable and maintainable open-source product.

### Scope
- One-command install from immutable release artifact plus short setup wizard.
- Dependency and existing reverse-proxy coexistence checks.
- Signed release manifest/artifacts.
- Staged update, health check, atomic version switch and rollback.
- Backup of configuration/state before migrations.
- Segmented transcript retention, quotas, purge/archive controls and free-space reserve.
- Safe uninstall/reset that does not silently destroy user data.
- Website/docs/privacy/support/release notes with truthful product status.
- Optional telemetry collector and minimal admin statistics.
- Feedback flow with retention/deletion.
- Independent security review of the public attack surface.

### Definition of Done
Clean install, update, failed update/rollback and migration recovery are all reproduced and documented.

## RELEASE 0005 — Large Transfer Hardening

Proposed version: **1.1.0**

- Chunked upload with bounded chunks and offset/checksum validation.
- Resumable upload/download and Range behavior.
- Explicit transfer status/progress independent of MCP wait.
- Bandwidth/concurrency caps.
- Crash-safe transfer manifest and orphan cleanup.
- Journaled EXDEV move only after it can be proven safe.
- Directory sync only after a conflict/traversal model exists.

## RELEASE 0006 — Optional Catalog Transport Pilot

Proposed version: **1.2.0**

Prerequisite: re-check the current OpenAI distribution path before building a custom Relay.

- Fixed public MCP facade only if required.
- Central account/server binding and pairing.
- Cryptographic device identity; never MAC as security identity.
- Agent-initiated outbound tunnel with fencing generation/backoff/jitter.
- Scoped grants and cross-tenant deny-by-default routing.
- Metadata-only central persistence.
- No durable command/output/file-body queue.
- Direct remains usable after Catalog pairing is removed.

The Relay may see plaintext in transit if it terminates TLS. Do not advertise it as zero-knowledge unless an additional end-to-end encryption design exists.

## RELEASE 0007 — Catalog Submission & Measured Scale

Proposed version: **1.3.0**

- Re-check official submission requirements immediately before submission.
- Reviewer-safe sandbox without production secrets.
- Positive and negative integration scenarios.
- Load/chaos tests based on active tunnels, request rate, bandwidth, RSS, FD usage, queue depth and latency.
- Add multi-node routing/Redis only if measured Relay load requires it.
- Document backup/restore/failover and deployment drain.

Catalog review never blocks Direct releases.

## MVP boundary

### Private working MVP — R0003
Must have:
- persistent terminal;
- safe operation lifecycle;
- recoverable output;
- bounded small file transfer;
- verified local auth/consent;
- revoke/reset;
- real client E2E;
- independence from central DP services.

### Public usable MVP — R0004
Additionally:
- reproducible installer;
- signed update/rollback;
- retention/quotas;
- security review;
- docs/privacy/support.

### Later
- complex billing;
- Kubernetes;
- enterprise SSO;
- organization RBAC;
- global multi-region;
- extra OS support;
- Docker/Git/database capabilities;
- antivirus adapter.

## Scaling model

### 1–10 users
Direct runs on each user's VPS. Local state is SQLite/files. Central services are optional.

### 100–1000 users
Direct remains distributed. Scale only telemetry/feedback/Relay components that actually receive central load. Central Postgres may be justified for Catalog metadata.

### 10,000+ installations
Installation count alone is not a capacity metric. Measure active tunnels, requests/sec, bytes/sec, concurrent operations, open FDs, RSS, disk and p95/p99 latency. Redis/message brokers appear only for demonstrated multi-node routing/queue needs. File payloads do not go into durable brokers.

## Telemetry rule

Telemetry is disabled by default.

An **active installation** is an installation that performs a meaningful terminal/file action, not one that merely started a service or sent a heartbeat.

Metrics must be labelled honestly:
- telemetry-enabled installations;
- daily/weekly/monthly active telemetry-enabled installations;
- Catalog registered accounts/devices when Catalog exists.

Do not call an installation count an exact count of people.

## Release discipline

- **BUILD:** CI result for one commit.
- **RELEASE:** approved immutable version/artifacts + release notes + required acceptance evidence.
- **DEPLOYMENT:** installation of a release in a specific environment.

Every release must document:
- exact commit SHA;
- migrations;
- test/acceptance evidence;
- deployment steps;
- rollback steps;
- known limitations.

Production rollback never implies resurrection of user files deleted by a command or arbitrary processes lost on OS reboot.

## Roadmap governance

1. Issues are small implementation units.
2. Fundamental deviations require an ADR/PR.
3. No milestone becomes DONE without links to code, CI and acceptance evidence.
4. Documentation must distinguish IMPLEMENTED, PLANNED and OPEN DECISION.
5. Work should proceed from GitHub, not from remembered chat context.

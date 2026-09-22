# Changelog

All notable changes are documented here.

## [Unreleased]

### Security

- Added a versioned SQLite operation ledger with HMAC-protected request fingerprints, per-session single-writer admission, idempotent retry/conflict semantics and fail-closed `UNKNOWN` reconciliation.
- Replaced PTY marker parsing with atomic per-operation exit records so forged or truncated terminal output cannot fabricate command completion.
- Submit the command, completion suffix and terminating Enter in one tmux buffer so sustained PTY output cannot reorder or flush the pending status write.
- Added descriptor-pinned workspace mutations with atomic no-replace commits, protected roots, overlap denial and fail-closed complex-operation handling.
- Added fail-closed HTTPS attachment fetching with DNS/IP pinning, redirect revalidation, private-address denial, deadlines, byte/concurrency ceilings and disconnect cancellation.
- Split MCP, Agent and restricted work execution into distinct UNIX identities and credential files.
- Added a standalone Session Host over a filesystem-permissioned UNIX socket; its environment rejects Agent/MCP credentials.
- Added a preserve-only live-session update policy and migration path for the existing tmux socket/state.
- Added allowlisted structured logging, route templates, bounded error categories and a no-access-log proxy profile for secret-bearing paths.

### Fixed

- Added backpressure-aware download pipelines, aggregate transfer admission, upload/copy disk reserve checks, hard transcript capture ceilings and production systemd resource controls.
- Added SQLite schema v2 retained-session metadata, versioned UTF-8-safe transcript cursors, explicit gap/degraded responses, and separate CLOSED-session purge.
- Aligned ChatGPT file inputs with the dated OpenAI contract: required `download_url`/`file_id`, optional `mime_type`/`file_name`, safe filename fallback, honest overwrite annotations and declared file-result schemas.
- Prevented move from pre-deleting an existing destination before a successful rename.
- Defined same-path move as a non-destructive no-op and disabled unsafe cross-device fallback.
- Added FILE-01, FILE-02, FILE-03 and FILE-09 data-loss regression coverage for DP-001.
- Made installation wait for local endpoint readiness before reporting success.
- Made `doctor` retry startup health sequentially and report failures without unhandled promise rejection stacks.
- Made the live MCP lifecycle wait for Session Host Unix-socket readiness after a systemd restart.
- Made updates activate the newly installed Session Host code: API admission is frozen, active operations fail closed, idle tmux sessions are preserved, and Unix-socket readiness is required before Agent/MCP restart.

### Testing

- Added TERM-04 through TERM-09 coverage plus legacy import, migration backup, interrupted-migration recovery, forged-output, large-output and transcript-independent completion tests.
- Added FILE-04 through FILE-09 race, root-protection, symlink-swap, path-overlap and unsupported-operation regression coverage.
- Added SSRF-01 through SSRF-08 coverage plus DNS-deadline, mixed-answer, credential-isolation and bounded-concurrency assertions.
- Added a versioned DP-003 compatibility fixture and MCP descriptor/call assertions for required identity, optional metadata and structured output.
- Added a real-tmux Agent lifecycle smoke in GitHub Actions covering timeout persistence, Agent restart/reconnect, interactive input and explicit close.
- Extended the systemd smoke with identity/ACL checks and Session Host restart persistence.
- Added an installed-runtime TERM-08/09 smoke with bounded failure forensics and optional failed-session preservation.
- Kept systemd/cgroup persistence explicitly outside this initial smoke; DP-002 remains open until disposable systemd evidence is linked.

### Documentation / planning

- Replaced the preliminary roadmap with the audited R0002–R0007 release sequence.
- Added target Direct/optional-Catalog architecture and trust boundaries.
- Added 2026-09-21 architecture/security audit.
- Added first implementation sprint and release acceptance test matrix.
- Added a full threat/control matrix, finding-to-test traceability and live implementation-status ledger.
- Standardized per-release user value, dependencies, migrations, tests, security, observability, rollback, documentation and exit gates.
- Added implementation Issue/PR evidence templates and decomposed the largest R0002 work items.
- Added release-process and privacy/telemetry decisions.
- Added accepted Architecture Decision Records.
- Created GitHub Issues DP-001 through DP-015 as the implementation queue.
- Corrected project scope: Linux VPS MCP bridge; Windows remote-desktop architecture is not part of this project.

### Critical implementation priorities

- P0: prevent destructive destination pre-delete in file move.
- P1: real tmux/systemd persistence tests, operation idempotency/concurrency, file-fetch SSRF controls, transcript/resource safety, runtime credential separation and log sanitization.
- OAuth/consent onboarding follows runtime hardening; Catalog Relay follows a distribution feasibility gate.

## [0.1.0] - Unreleased technical preview

### Added

- RELEASE 0001 repository foundation.
- Persistent `tmux` terminal session contract.
- Modular terminal and file capability boundaries.
- Local agent authentication and path policy.
- Initial MCP tool surface.
- Direct point-to-point deployment model with optional future Catalog relay.
- File upload/download support with atomic writes and expiring download links.
- Symlink-aware allowed-root enforcement.
- Explicit-consent telemetry client with a field allowlist.
- Daily aggregate telemetry collector with keyed installation hashes.
- Privacy, feedback, migration, support, and publishing documentation.
- systemd service templates, installer foundation, and diagnostics.
- Automated syntax, API, storage, path, transfer, and privacy tests.

# Changelog

All notable changes are documented here.

## [Unreleased]

### Fixed

- Prevented move from pre-deleting an existing destination before a successful rename.
- Defined same-path move as a non-destructive no-op and disabled unsafe cross-device fallback.
- Added FILE-01, FILE-02, FILE-03 and FILE-09 data-loss regression coverage for DP-001.

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

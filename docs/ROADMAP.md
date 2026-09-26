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

## How to use this roadmap

Every release gate is evaluated against the same evidence contract:

- **User value:** the externally observable result delivered by the release.
- **Scope / out of scope:** the capability boundary; omitted work is not implied.
- **Dependencies:** issues, decisions and environments required before acceptance.
- **State and migration:** schema/configuration changes and recovery behavior.
- **Tests:** automated and manual evidence tied to the exact commit.
- **Security gate:** risks that must be fixed or explicitly disabled.
- **Observability:** bounded signals required to diagnose the release without collecting sensitive content.
- **Definition of Done:** the release-level acceptance decision.
- **Rollback:** what can be restored and what cannot be promised.
- **Documentation:** user/operator/developer material that must match actual behavior.
- **Exit criterion:** the condition that allows work on the next release to become the primary track.

The detailed evidence map is maintained in `docs/audit/TRACEABILITY.md`; live status is maintained in `docs/IMPLEMENTATION_STATUS.md`. A green unit-test build alone never satisfies a release gate.

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
Status: **VERIFIED**

### Goal
Make the existing local vertical slice safe enough to expose to real clients.

### User value
A private evaluator can use the terminal and small-file vertical slice without known silent data-loss behavior, false completion claims or accidental coupling between API restarts and live work.

### Dependencies
- R0001 technical-preview codebase;
- DP-001 through DP-011 plus residual gate DP-016;
- DP-017 for the final actual-client compatibility evidence;
- disposable Linux/systemd/tmux integration environment;
- accepted ADR-003, ADR-004, ADR-006, ADR-007, ADR-010 and ADR-013.

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

Migration evidence must cover preflight, backup, forward migration, interrupted migration and recovery. If legacy data cannot be interpreted safely, preserve it and stop with an actionable error.

### Required tests
- FILE-01 through FILE-12 where the related capability remains enabled;
- TERM-01 through TERM-12, including real process persistence across MCP/Agent restart;
- CUR-01 through CUR-06;
- SSRF-01 through SSRF-08;
- STR-01 through STR-05;
- LOG-01 through LOG-06;
- OPS-03 for no implicit root runtime.
- Actual ChatGPT DP-003 file-contract evidence plus the immediate tunnel peer
  identity through the outbound-only, test-only transport defined by ADR-013
  and DP-017.

### Security gate
- F01 is closed with regression evidence.
- Included F02-F14 paths are fixed, constrained or explicitly disabled.
- Work execution cannot read MCP/Agent authorization secrets in the restricted profile.
- No raw command, transcript, credential or secret-bearing URL appears in operational/diagnostic evidence.

### Observability
- structured operation/session events with identifiers, status, duration and error category;
- degraded-state signals for storage, capture gaps and resource admission failures;
- no raw commands, transcript data, file bodies, credentials or unrestricted paths in operational logs.

### Definition of Done
- All known P0 issues closed.
- P1 issues in the included runtime either fixed or capability explicitly disabled.
- A long-running command survives MCP and Agent restart on a disposable Linux/systemd host.
- A retry does not accidentally execute the same managed operation twice.
- Shell execution profile cannot read MCP/Agent authorization secrets.
- Known data-loss file cases have regression tests.
- Evidence references exact commit + CI/runtime run.
- The actual target ChatGPT app accepts the enabled DP-003 file contract, while
  the local MCP boundary records its real immediate tunnel peer, without
  requiring a public preview-bearer endpoint.

### Not in R0002
Public OAuth onboarding, production reliance on OpenAI Secure MCP Tunnel, polished installer, Relay, large resumable transfers, billing, multi-tenant features.

### Rollback
Rollback may restore service code and compatible state backups. It must not re-enable the known destructive move behavior, replay an uncertain shell operation or delete legacy state. An incompatible schema downgrade is blocked explicitly.

### Documentation
Update architecture/contracts, migration notes, known limitations, issue evidence and the test matrix for every changed runtime semantic.

### Exit criterion
R0003 becomes the primary track only after the R0002 Definition of Done is linked to an exact commit and real Linux runtime evidence. DP-017 may use OpenAI Secure MCP Tunnel only to collect actual-client acceptance evidence while the Beget MCP listener remains private; that evidence does not satisfy the R0003 HTTPS/OAuth gate.

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

### User value
An invited owner can connect the actual target ChatGPT/Codex client to a stable HTTPS endpoint, grant explicit access, resume a long-running task and revoke or re-pair access without depending on central DP services.

### Dependencies
- accepted R0002 runtime evidence;
- DP-012 through DP-014;
- stable test hostname and supported TLS/reverse-proxy configuration;
- verified target-client registration behavior rather than an assumed Dynamic Client Registration requirement.

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

### State and migration
Add versioned owner, client, grant, token-family and revocation state. Auth migration must fail closed, retain terminal transcripts and provide an owner recovery/reset path that cannot silently broaden scopes.

### Required tests
- AUTH-01 through AUTH-10;
- mandatory R0003 end-to-end scenario in `docs/audit/TEST_MATRIX.md`;
- AUTO-01 through AUTO-04 with website, telemetry and feedback unavailable;
- N/N-1 capability-contract check for the supported private-beta path.

### Observability
Record sanitized authorization lifecycle events, grant/revoke outcomes and component health without access/refresh tokens, authorization codes, redirect secrets or terminal/file content.

### Definition of Done
- Real client can open a persistent terminal, start a task, stop waiting, reconnect and continue reading.
- Revoke blocks new mutations.
- Small upload/download succeeds using the actual client contract.
- Direct keeps working with all central DP services unavailable.

### Out of scope
Catalog Relay, unattended mass deployment, public one-command lifecycle guarantees, large resumable transfer and organization/multi-owner RBAC.

### Rollback
The previous runtime may be restored only when state compatibility is proven. Revoked credentials must never become valid again after rollback; reset must retain local transcripts unless the owner separately purges them.

### Documentation
Publish the verified client pairing flow, consent/scopes, revoke/reset/re-pair behavior, supported deployment matrix and private-beta limitations.

### Exit criterion
R0004 starts as the primary track only after the real-client E2E record identifies client version, server commit, OS/systemd/tmux/Node versions and pass/fail evidence without secrets.

## RELEASE 0004 — Public Direct 1.0

Proposed version: **1.0.0**  
Status: **IN PROGRESS — NOT DEPLOYABLE**. Implementation evidence is tracked in `docs/IMPLEMENTATION_STATUS.md`; the release gate below remains open.

### Goal
Turn the private beta into a reproducibly installable and maintainable open-source product.

### User value
A Linux VPS owner can install, update, diagnose, roll back and remove Direct Mode through a documented supported path without manually assembling internal service configuration.

### Dependencies
- accepted R0003 private-beta evidence;
- immutable artifact/signing design and protected release credentials;
- supported Linux/reverse-proxy matrix;
- independent review scope defined for the public attack surface.

### Scope
- One-command install from immutable release artifact plus short setup wizard.
- Dependency and existing reverse-proxy coexistence checks.
- Signed release manifest/artifacts.
- Staged update, health check, atomic version switch and rollback.
- Backup of configuration/state before migrations.
- Segmented transcript retention, quotas, explicit purge/archive controls and free-space reserve. R0004 retains local output until the owner explicitly purges it; automatic age-based deletion is not part of this release.
- Safe uninstall/reset that does not silently destroy user data.
- Website/docs/privacy/support/release notes with truthful product status.
- Optional telemetry collector and minimal admin statistics.
- Feedback flow with retention/deletion.
- Independent security review of the public attack surface.

### Definition of Done
Clean install, update, failed update/rollback and migration recovery are all reproduced and documented.

### State and migration
All configuration/state migrations are versioned, backed up and preflighted. Activation uses a staged version directory and an atomic switch. Uninstall/reset distinguishes service removal from explicit user-data purge.

### Required tests
- OPS-01 through OPS-09;
- AUTO-01 through AUTO-04;
- TEL-01 through TEL-07 only when telemetry is enabled for the tested profile;
- clean install, update, failed migration, failed health check and N/N-1 rollback on every supported platform profile.

### Security gate
- immutable artifact digest/signature verification is enforced;
- no implicit root runtime and no destructive uninstall default;
- segmented transcript retention, quotas and free-space reserve are active;
- public attack surface completes independent security review or documented blocking findings remain unresolved and release is withheld.

### Observability
Expose local health/readiness, installed version/commit, state schema, bounded resource status and sanitized doctor output. Optional telemetry remains disabled by default and is never required for health or authorization.
R0004 requires enough sanitized local diagnostics to identify a failed install, update or auth step without logging credentials, tokens or user content. Cross-service request correlation and a support bundle may follow after the core migration and rollback work, unless the security review identifies a release-blocking need. Group related verification after substantive changes while retaining the mandatory release and security gates.

### Out of scope
Large resumable transfers, directory synchronization, Catalog transport, organization RBAC, billing and speculative scale infrastructure.

### Rollback
Use verified previous artifacts and compatible state backups. Failed activation returns to the previous healthy version. Rollback does not promise recovery of command side effects, deleted user files or processes lost on OS reboot.

### Documentation
Publish install/update/rollback/uninstall, privacy, security reporting, support, release notes, compatibility matrix and known limitations. Website claims must match the released evidence.

### Exit criterion
R0005 or the Catalog feasibility work may proceed after the signed 1.0 artifact and its complete release record are published; neither downstream track can retroactively weaken Direct 1.0 gates.

## RELEASE 0005 — Large Transfer Hardening

Proposed version: **1.1.0**

### Goal and user value
Support large and interruptible transfers without memory growth proportional to payload size, ambiguous completion or unsafe partial replacement.

### Dependencies
Accepted R0004 lifecycle/update foundation, bounded streaming primitives from DP-010 and a versioned transfer-state design.

### Scope
- Chunked upload with bounded chunks and offset/checksum validation.
- Resumable upload/download and Range behavior.
- Explicit transfer status/progress independent of MCP wait.
- Bandwidth/concurrency caps.
- Crash-safe transfer manifest and orphan cleanup.
- Journaled EXDEV move only after it can be proven safe.
- Directory sync only after a conflict/traversal model exists.

### Out of scope
General-purpose object storage, durable central payload queues and directory sync without an explicit conflict/security model.

### State and migration
Add versioned transfer manifests, chunk offsets, expected/computed digests, expiry and orphan-cleanup state. Migration preserves recoverable partial uploads or marks them safely abandoned.

### Tests and security gate
Prove bounded RSS with slow consumers, offset/digest mismatch rejection, restart/resume, disconnect cancellation, concurrency/bandwidth caps, disk reserve, orphan cleanup and journaled EXDEV recovery. No capability is enabled when its partial-commit semantics remain ambiguous.

### Observability
Expose transfer ID, coarse progress/status, bounded rate/error categories and cleanup outcome without central file names, paths or contents.

### Definition of Done / exit criterion
Large upload and download resume correctly after transport interruption and process restart, preserve existing destination data on every tested failure, and have linked performance/resource evidence. Only then may directory sync or server-to-server transfer advance.

### Rollback and documentation
Rollback retains compatible manifests and never converts an incomplete transfer into a committed file. Document size limits, resume behavior, checksums, cleanup, quotas and unsupported conflict cases.

## RELEASE 0006 — Optional Catalog Transport Pilot

Proposed version: **1.2.0**

Prerequisite: re-check the current OpenAI distribution path before building a custom Relay.

### Goal and user value
If a fixed central transport is still required, allow a small invited cohort to reach the same Direct capabilities through explicit account/device pairing while keeping Direct independently usable.

### Dependencies
Accepted R0004 Direct release, a dated distribution-feasibility decision, ADR for any architecture change, Catalog threat model and two-owner isolation test environment.

### Scope
- Fixed public MCP facade only if required.
- Central account/server binding and pairing.
- Cryptographic device identity; never MAC as security identity.
- Agent-initiated outbound tunnel with fencing generation/backoff/jitter.
- Scoped grants and cross-tenant deny-by-default routing.
- Metadata-only central persistence.
- No durable command/output/file-body queue.
- Direct remains usable after Catalog pairing is removed.

The Relay may see plaintext in transit if it terminates TLS. Do not advertise it as zero-knowledge unless an additional end-to-end encryption design exists.

### Out of scope
General availability, multi-region, billing, organization RBAC, durable command/output/file queues and claims of zero knowledge without a proven E2E design.

### State and migration
Central state is limited to account/server binding, cryptographic device identity, grant metadata and tunnel generation. Pairing removal must not damage local Direct state. Schema rollback must not revive revoked devices or grants.

### Tests and security gate
CAT-01 through CAT-07, AUTH revocation/replay cases, bounded relay-memory checks and direct-autonomy tests are mandatory. Cross-owner identifiers deny by default; stale tunnel generations are fenced; central persistence/log inspection shows no durable command/output/file bodies.

### Observability
Measure active tunnels, routing errors, bounded bytes/latency, reconnect/backoff and queue pressure using tenant-safe metadata. Disable body tracing and disk buffering by default.

### Definition of Done / exit criterion
An invited pilot can pair, route, revoke and fall back to Direct; cross-tenant negative tests pass; Relay failure does not duplicate managed operations. R0007 waits for both this evidence and a current submission-policy review.

### Rollback and documentation
Disable Catalog routing and revoke central pairings without disabling Direct. Document transit visibility, central metadata, retention, failure behavior and removal procedure.

## RELEASE 0007 — Catalog Submission & Measured Scale

Proposed version: **1.3.0**

### Goal and user value
Submit a reviewer-safe Catalog integration and scale only the central transport components justified by measured pilot demand.

### Dependencies
Accepted R0006 pilot, current official submission requirements, reviewer sandbox and measured capacity/reliability targets.

### Scope
- Re-check official submission requirements immediately before submission.
- Reviewer-safe sandbox without production secrets.
- Positive and negative integration scenarios.
- Load/chaos tests based on active tunnels, request rate, bandwidth, RSS, FD usage, queue depth and latency.
- Add multi-node routing/Redis only if measured Relay load requires it.
- Document backup/restore/failover and deployment drain.

Catalog review never blocks Direct releases.

### Out of scope
Unmeasured multi-region/Kubernetes/broker work, central payload retention and any change that makes Direct depend on Catalog availability.

### State and migration
Any scale-out routing state has explicit ownership, fencing, backup/restore and drain semantics. Redis or another coordinator is introduced only with a recorded capacity reason and recovery test.

### Tests and security gate
Repeat CAT-01 through CAT-07 at deployment scale; add load, soak, failover, drain and reviewer scenarios. Re-check official OpenAI requirements immediately before submission. Reviewer environments contain no production secrets or user data.

### Observability
Publish SLO-oriented metrics for active tunnels, request/byte rate, RSS, file descriptors, queue depth and p95/p99 latency with tenant-safe labels and retention.

### Definition of Done / exit criterion
Submission evidence, reviewer scenarios, operational runbooks, measured capacity and failure recovery are complete. External approval is reported separately from engineering readiness.

### Rollback and documentation
Traffic can drain to the last healthy deployment or Catalog can be disabled while Direct remains available. Document submission version, deployed commit, routing topology, backup/restore/failover and incident response.

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

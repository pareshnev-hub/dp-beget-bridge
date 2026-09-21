# DP Beget Bridge — Target Architecture

Date: 2026-09-21  
Status: **ACCEPTED TARGET / implementation may lag behind this document**

This document defines the target architecture after review of the current repository and product context. It is Linux VPS infrastructure, not a Windows remote-desktop agent.

## 1. Product boundary

A single owner connects ChatGPT/Codex to their Linux VPS.

- Terminal sessions live on the VPS, not inside one MCP request.
- File operations and terminal capabilities are shared by Direct Mode and any future Relay mode.
- Multiple mutually untrusted owners sharing one UNIX identity are not supported.
- Direct Mode does not require a DP account, central database, website heartbeat or remote permission check.

The ChatGPT/Codex platform itself remains an external dependency of the client experience.

## 2. Direct trust boundaries

```text
ChatGPT / Codex
      |
      | HTTPS + OAuth access token
      v
USER-CONTROLLED VPS / stable hostname
      |
      +-- existing reverse proxy OR Caddy
      |
      +-- DP MCP + local Authorization Server
      |       identity: dp-mcp
      |       stores auth keys/grants, not terminal data
      |
      +-- authenticated local IPC
              |
              v
          DP Agent / policy
          identity: dp-agent
              |
              +--> Session Host
              |    identity: dp-work
              |    explicit tmux socket
              |    shell/child processes
              |    local transcript segments
              |
              +--> File Worker
                   scoped filesystem access
```

Optional and outside Direct execution:
- website/docs/downloads;
- telemetry collector;
- feedback backend;
- signed release/update source;
- future Catalog Relay.

### Control plane
Enrollment, OAuth grants, authorization policy, capability discovery, session/operation metadata.

### Data plane
stdin/stdout, transcript bytes, file bytes.

Sensitive data-plane content remains on the VPS and is returned to the chosen MCP client. "DP does not centrally store commands/output" does not mean the client provider never sees content.

## 3. Process and privilege model

Root may be needed by the installer to create users, units and approved policies. It is not the default runtime identity.

Target identities:
- `dp-mcp`: network-facing MCP/auth service;
- `dp-agent`: local capability/policy service;
- `dp-work`: execution/session host.

Requirements:
- Shell tasks cannot read MCP/Agent auth secrets in the restricted profile.
- Service code/auth storage/updater trust roots are not writable by the work identity.
- No Docker socket or default sudo in the restricted profile.
- Agent API stays local; target IPC is a UNIX socket with ACL/caller identity.
- Accidentally exposing Agent API on `0.0.0.0` must require an explicit dangerous-mode configuration.

### Root/admin execution
A true root shell on the same host changes the trust boundary. Do not claim that service secrets can remain inaccessible from unrestricted host-root execution. If administrative execution is supported, it is an explicit owner-selected profile with prominent disclosure.

## 4. Session Host lifecycle

The session owner must not be a short-lived MCP/Agent process.

Target:
- standalone Session Host lifecycle;
- explicit `tmux -S` socket outside `PrivateTmp`;
- MCP/Agent restart does not kill sessions;
- update/uninstall does not silently destroy unrelated or live sessions;
- Session Host updates with live terminals use an explicit drain/manual policy.

The current `KillMode=process` setting is not proof of full lifecycle safety. Real systemd/tmux integration tests are required.

## 5. Technology stack

Keep:
- JavaScript ESM;
- Model Context Protocol SDK;
- Zod;
- Node.js;
- systemd;
- tmux.

Do not rewrite the project to Rust/Go/TypeScript solely for architecture aesthetics.

### Runtime version
Maintain compatibility with the current Node baseline while introducing a tested supported-LTS matrix. Version changes require CI evidence.

### Local state
Use a transactional local state adapter, targeted at SQLite, for:
- sessions metadata;
- operation ledger;
- owner/grants;
- schema migrations;
- transcript segment metadata.

Transcript bodies remain local files, not database BLOBs.

Do not deploy Postgres/Redis on every user VPS for a single-owner Direct installation.

## 6. Authorization model

Target local flow:
- standards-based OAuth/OIDC adapter;
- Authorization Code;
- PKCE S256;
- exact redirect URI policy;
- issuer/resource/audience validation;
- short access tokens;
- refresh rotation/reuse detection;
- revocation;
- reset/re-pair;
- one-time owner bootstrap.

Client registration mode must be selected by compatibility tests with the actual client rather than assumed.

### Grants/scopes
Candidate scopes:
- `terminal:read`
- `terminal:execute`
- `terminal:input`
- `terminal:close`
- `files:read`
- `files:write`
- `files:delete`

Full shell execution can perform filesystem actions within OS rights regardless of separate file-tool scopes. This must be disclosed during consent.

### Dangerous action approval
A model argument such as `confirmed=true` is not human approval.

Use either:
- a nonce-bound human approval linked to owner/resource/operation digest/expiry; or
- an explicit pre-authorized unattended grant with constrained scope.

Prompt-injected content in terminal/file output is data and cannot expand authorization.

## 7. Session and Operation model

### Session
Suggested fields:
- id;
- owner_id;
- execution_profile;
- runner_id;
- created_at;
- closed_at;
- status;
- transcript_stream_id.

States:
`CREATING -> OPEN -> CLOSING -> CLOSED`

Additional honest states may include `LOST`, `ERROR`, `RECOVERY_REQUIRED`.

Connection state is separate from Session state.

### Operation
Suggested fields:
- id;
- session_id;
- requester;
- idempotency_key;
- request_fingerprint;
- status;
- accepted_at;
- started_at;
- completed_at;
- exit_code;
- outcome_reason.

Do not store raw command text in operational logs.

States:
`ACCEPTED -> RUNNING -> SUCCEEDED | FAILED | INTERRUPTED`

`WAITING_INPUT` and `UNKNOWN` are valid.

### Concurrency/idempotency
- One writer per terminal session.
- A new managed command does not get pasted into the stdin of an already-running managed command.
- Same idempotency key + same fingerprint returns the existing operation.
- Same key + different payload is a conflict.
- Crash ambiguity returns `UNKNOWN`; do not silently replay arbitrary shell commands.
- Do not claim exactly-once execution across arbitrary failures.

### Completion
Managed command completion/status must be independent of terminal stdout. Echoed/forged markers in PTY output are not authoritative completion evidence.

## 8. Transcript contract

Use a logical cursor with stream identity/epoch + absolute byte offset.

Read returns:
- next cursor;
- earliest available cursor;
- data;
- has_more;
- explicit gap information when old content was removed.

Requirements:
- no silent cursor clamp to end;
- UTF-8-safe decoding across chunk boundaries;
- independent readers;
- retained CLOSED session metadata;
- purge as an explicit destructive action;
- transcript capture lifecycle independent of MCP/API restarts.

### Resource ceilings
Installer/config establishes:
- max sessions;
- max parallel transfers;
- transcript budget;
- output rate/buffer caps;
- minimum free-space reserve;
- max queued bytes.

When storage is exhausted:
- reject new writes/commands as needed;
- preserve a service reserve;
- expose degraded state;
- if transcript capture must drop bytes, report a gap instead of silently hanging the terminal.

A persistent process does not imply infinite transcript retention.

## 9. File safety contract

### Incoming attachment fetch
- HTTPS policy;
- validate DNS/IP at every relevant hop;
- reject loopback/private/link-local destinations unless explicitly trusted by contract;
- validate redirects;
- bounded response size;
- deadline;
- bounded concurrency;
- cancel upstream on downstream disconnect;
- never forward Agent credentials to the download origin.

### Workspace mutations
- Never `rm(destination)` before a successful replacement commit.
- Same source/destination must not destroy data.
- `overwrite=false` requires atomic no-replace semantics.
- Deleting/moving configured root is forbidden.
- Dangerous ancestor/descendant overlaps are rejected.
- Complex EXDEV/directory replacement remains unsupported until journaled and tested.
- Realpath checking alone is not a complete TOCTOU defense.

### Transfer behavior
Preserve streaming backpressure end-to-end. SHA-256 calculation is not the same as verifying an expected digest. Large/resumable transfer is a later capability once bounded correctness is proven.

## 10. Logging and privacy

Operational logs may include:
- timestamp;
- component;
- event;
- severity;
- duration;
- session/operation IDs;
- error category;
- product version.

Operational logs must not include:
- command text;
- terminal output;
- file bodies;
- full paths/filenames unless a local debug mode explicitly requires them;
- bearer/refresh tokens;
- OAuth codes;
- cookies/passwords/API keys;
- download-grant URLs.

Redaction must not rely only on JSON key names; URLs and exception text require sanitization.

Terminal continuity logs are sensitive local data and remain on the VPS.

## 11. Optional telemetry

Telemetry is opt-in and disabled by default.

Central telemetry stores only a strict allowlist of coarse product events/aggregates. Runtime never waits for the collector.

An active installation means a meaningful terminal/file action, not service startup/heartbeat.

Installation identifiers are pseudonymous, not guaranteed anonymous.

## 12. Future Catalog mode

```text
OpenAI client
    |
    v
fixed DP MCP facade
    |
central owner/grant/server metadata
    |
Relay router (transit only; bounded memory)
    |
agent-initiated outbound tunnel
    |
same Agent/Session/File capabilities
```

Rules:
- Direct and Catalog share capabilities; no duplicate terminal implementation.
- Device identity is cryptographic, never MAC-based.
- Pairing and server binding are explicit.
- Tunnel uses reconnect/backoff/jitter and fencing generation.
- No durable storage of commands/output/file bodies in Relay.
- No body tracing/disk buffering by default.
- If Relay terminates TLS, it can see transit plaintext. Do not call it zero-knowledge without an additional E2E encryption design.
- Direct remains available independently.

Before writing the Relay, re-check whether the current OpenAI distribution path actually requires a custom fixed-endpoint Relay.

## 13. Failure containment

| Failure | Expected behavior |
|---|---|
| DP website/feedback/analytics down | Direct continues |
| update source down | current installed version continues |
| MCP/API down | new calls fail; Session Host keeps live processes |
| local auth/state failure | new grants/mutations fail closed; running tasks are not silently killed |
| Session Host/OS down | sessions may be LOST; local persisted metadata/output survive if disk survived |
| disk full | reject new writes, preserve reserve, report degraded/gaps |
| DNS/TLS down | new HTTPS client access fails; local sessions remain independent |
| Catalog Relay down | Catalog unavailable; Direct unaffected |

## 14. Scaling

### 1–10 users
Each user VPS owns its runtime; local SQLite/files; optional central website/telemetry.

### 100–1000 users
Direct is still distributed. Scale only central services that receive actual traffic. Catalog metadata may justify central Postgres.

### 10,000 installations
Measure active tunnels, requests/sec, bytes/sec, concurrent operations, RSS, FDs, queue depth and p95/p99 latency. Add Redis/message brokers only for demonstrated multi-node routing/queue requirements. Do not put user file payloads in durable message brokers.

## 15. Protocol evolution

Expose:
- product_version;
- protocol_version;
- state_schema_version;
- capabilities.

Changes are additive where possible. Breaking changes require a new protocol major. Release/rollback compatibility should include N/N-1 contract tests.

## 16. Architecture governance

Fundamental changes require an ADR. The roadmap is the release-order source of truth. Issues are implementation work units, not architecture overrides.

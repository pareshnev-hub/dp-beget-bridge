# First implementation sprint — DP Beget Bridge

Date: 2026-09-21  
Status: accepted implementation plan.

Planning IDs below are stable references. GitHub issue numbers are repository-generated.

## Execution order

```text
DP-001 immediately

parallel:
DP-002  DP-003  DP-011

then:
DP-003 -> DP-004 -> DP-010
DP-001 -> DP-005
DP-002 -> DP-006 -> DP-007 / DP-008 -> DP-010
DP-002 -> DP-009

auth after safe runtime:
DP-003 + DP-009 -> DP-012 -> DP-013 -> DP-014

optional analytics:
DP-015 (does not block runtime while telemetry is OFF)
```

Do not merge the whole program as one giant PR. Preferred pattern: regression test -> focused fix -> CI/evidence -> close issue.

---

## DP-001 — Prevent destructive move pre-delete

**Priority:** P0  
**Milestone:** R0002  
**Depends:** none

Remove destination pre-delete behavior. Define safe same-path semantics. Temporarily reject replacement cases that cannot be made atomic/safe.

Files:
- `apps/agent/src/files.js`
- `test/files.test.js`

Acceptance:
- same path never deletes source;
- missing source leaves destination byte-for-byte unchanged;
- rename error leaves both objects safe;
- unsupported EXDEV/complex replacement performs no mutation.

Required tests:
- same path;
- missing source;
- existing destination;
- injected rename failure;
- unsafe EXDEV.

Rollback:
- unsafe operation remains disabled rather than reverting to known lossy behavior.

---

## DP-002 — Add source-linked baseline and real runtime CI

**Priority:** P1  
**Milestone:** R0002  
**Depends:** none

Add tests that import real modules plus a real tmux/systemd runtime matrix on disposable infrastructure.

Files:
- `.github/workflows/ci.yml`
- `test/integration/`
- `docs/audit/`

Acceptance:
- CI reports Node/tmux/OS versions;
- long-running command survives API restart;
- timeout stops waiting but not process;
- evidence contains exact commit and no secrets.

---

## DP-003 — Align OpenAI file schemas and tool descriptors

**Priority:** P1  
**Milestone:** R0002  
**Depends:** none

Align file parameter schema/descriptors and destructive annotations with the actual target-client contract.

Files:
- `apps/mcp/src/mcp-server.js`
- `test/mcp-http.test.js`
- contract tests

Acceptance:
- required file reference/identity fields are enforced according to verified client contract;
- optional filename/mime metadata is handled correctly;
- missing optional filename does not crash normal flow;
- overwrite/destructive tools are marked honestly;
- structured output matches declared schema.

---

## DP-004 — Bound outbound file fetch and block SSRF

**Priority:** P1  
**Milestone:** R0002  
**Depends:** DP-003

Introduce source URL policy and egress defense.

Files:
- `apps/mcp/src/agent-client.js`
- `packages/core/src/`
- `test/security/`

Acceptance:
- loopback/private/link-local destinations blocked unless explicitly allowed by verified contract;
- redirects revalidated;
- IPv4 and IPv6 handled;
- timeout aborts both sides;
- size limit enforced;
- Agent bearer never sent to source origin;
- unrestricted-fetch fallback does not exist.

Required tests:
- IPv4/IPv6 loopback;
- redirect to private target;
- DNS/rebinding fixture where practical;
- slow body;
- oversized body;
- downstream disconnect.

---

## DP-005 — Protect workspace mutations against races

**Priority:** P1  
**Milestone:** R0002  
**Depends:** DP-001

Define safe mutation primitives and temporarily remove unsafe recursive/replacement semantics.

Files:
- `apps/agent/src/files.js`
- `packages/core/src/path-policy.js`
- `test/security/`

Acceptance:
- `overwrite=false` cannot replace a concurrently-created destination;
- configured root cannot be delete/move target;
- unsafe symlink mutation cannot escape OS scope;
- dangerous ancestry overlaps rejected;
- one invalid directory entry does not unnecessarily corrupt unrelated state.

---

## DP-006 — Introduce single-writer operation ledger

**Priority:** P1  
**Milestone:** R0002  
**Depends:** DP-002

Assign operation IDs before execution. Add idempotency key + request fingerprint and one writer per session.

Files:
- `apps/agent/src/tmux.js`
- `apps/agent/src/state-store.js`
- new state adapter
- integration tests

Acceptance:
- duplicate request does not start a second process;
- concurrent managed command receives BUSY or explicit bounded queue result;
- same key + different payload rejected;
- crash ambiguity returns UNKNOWN.

Do not put raw commands in operational logs.

---

## DP-007 — Separate completion status from PTY output

**Priority:** P1  
**Milestone:** R0002  
**Depends:** DP-006

Replace stdout marker search as authoritative managed-operation completion.

Files:
- terminal manager;
- Session Host;
- integration tests.

Acceptance:
- echoed/forged marker cannot produce false completion;
- >256 KiB output does not hide authoritative status;
- interactive/exec/exit cases do not fabricate success;
- status survives transcript-retention changes.

---

## DP-008 — Preserve archived output and cursor integrity

**Priority:** P1  
**Milestone:** R0002  
**Depends:** DP-006

Keep CLOSED metadata, make purge separate, and define cursor semantics.

Files:
- `apps/agent/src/state-store.js`
- `apps/agent/src/tmux.js`
- state tests

Acceptance:
- retained output is readable after restart;
- readers have independent cursors;
- UTF-8 boundaries do not corrupt text;
- expired/rotated cursor returns explicit gap.

---

## DP-009 — Separate runner lifetime and service credentials

**Priority:** P1  
**Milestone:** R0002  
**Depends:** DP-002

Create explicit service/work identities, clean environment and separate Session Host ownership.

Files:
- `deploy/install.sh`
- `deploy/systemd/`
- terminal/session host modules

Acceptance:
- restricted runner cannot read service secrets;
- API restart leaves target process alive;
- explicit socket remains addressable after API restart;
- close affects only selected session;
- root is not the implicit normal runtime user.

Do not "fix" this only by changing `KillMode`.

---

## DP-010 — Enforce streaming backpressure and disk ceilings

**Priority:** P1  
**Milestone:** R0002  
**Depends:** DP-004, DP-008

Bound streaming, cancellation and storage/resource use.

Files:
- `apps/mcp/src/server.js`
- file manager;
- Session Host;
- integration tests

Acceptance:
- slow consumer does not cause memory growth proportional to full file size;
- disconnect closes upstream;
- disk-full does not silently kill terminal process;
- quota rejects new writes cleanly;
- output gap/degraded state is explicit.

---

## DP-011 — Prevent credentials in logs and diagnostics

**Priority:** P1  
**Milestone:** R0002  
**Depends:** none

Use event-field allowlists, route templates and sanitized errors. Review reverse-proxy logging and support exports.

Files:
- `packages/core/src/logger.js`
- MCP/Agent servers
- Caddy example
- diagnostics

Acceptance:
- download token absent from debug/error logs;
- secret in exception string is removed;
- diagnostic export contains no commands, transcript, path secrets or credentials.

---

## DP-012 — Prove local OAuth discovery and client registration

**Priority:** P1  
**Milestone:** R0003  
**Depends:** DP-003, DP-009

Small compatibility spike for the actual target client.

Acceptance:
- metadata is accepted by actual client;
- PKCE S256 advertised/enforced;
- issuer/resource binding correct;
- redirect URI exact;
- client registration mode is verified rather than guessed.

No no-auth fallback on failure.

---

## DP-013 — Implement owner consent and authorization grants

**Priority:** P1  
**Milestone:** R0003  
**Depends:** DP-012, DP-006

One-time bootstrap, owner identity, execution-profile consent and scoped grants.

Acceptance:
- bootstrap code one-use + expiring;
- another owner cannot access a session;
- unattended grant has owner/scope/expiry;
- full shell rights are disclosed;
- model tool arguments cannot forge human approval.

---

## DP-014 — Add refresh revocation and re-pair lifecycle

**Priority:** P1  
**Milestone:** R0003  
**Depends:** DP-013

Implement refresh rotation/reuse detection, family revoke, reset and re-pair.

Acceptance:
- reused old refresh cannot create a new chain;
- revoke blocks new writes;
- reset does not delete local transcript;
- running-task policy is explicit to owner;
- DB/auth failure is fail-closed.

---

## DP-015 — Correct opt-in analytics and collector recovery

**Priority:** P2  
**Milestone:** R0004  
**Depends:** none

Does not block Direct runtime while telemetry remains disabled.

Acceptance:
- service startup is not counted as active usage;
- two same-day meaningful actions from one installation count once for DAU;
- one I/O failure does not permanently break future event processing;
- retention runs without requiring service restart;
- disabled telemetry performs no network call;
- metrics are labelled as telemetry-enabled installations, not exact people.

Security:
- HMAC identifier is described as pseudonymous, not anonymous;
- feedback and telemetry are not linked without separate consent.

## Sprint completion rule

R0002 is not complete when all issue titles merely exist. It is complete only when:
- P0 is closed;
- included P1 capabilities are fixed or disabled;
- integration evidence proves tmux/systemd persistence;
- no known runtime path can silently lose user files;
- the exact acceptance evidence is linked from the issue/PR/release record.

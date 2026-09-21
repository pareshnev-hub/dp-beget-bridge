# DP Beget Bridge — Threat Model

Date: 2026-09-21
Status: **SOURCE OF TRUTH / implementation may lag**

This document turns the audit findings into prevention, detection and response requirements. It does not assert that a control is implemented unless `docs/IMPLEMENTATION_STATUS.md` links implementation and verification evidence.

## Trust boundaries and assets

Primary trust boundaries:

1. target client to public MCP/OAuth endpoint;
2. MCP/auth service to local Agent/policy service;
3. Agent to Session Host/File Worker;
4. restricted `dp-work` identity to host operating system;
5. Direct runtime to optional telemetry/feedback/update services;
6. future Catalog facade/Relay to owner/device/tunnel routing.

Protected assets include authorization credentials, owner grants, local state, terminal sessions/transcripts, file contents and integrity, update trust roots, and tenant/server bindings.

## Risk scale

- **P0:** likely or demonstrated critical data loss/security compromise.
- **P1:** blocks a working or public runtime capability.
- **P2:** required before the related public/optional service launches.
- **P3:** defense-in-depth or operational improvement.

## Threat/control matrix

| ID | Threat and boundary | Prevention | Detection | Response / residual risk | Owner issue / gate |
|---|---|---|---|---|---|
| TM-01 | Compromised MCP URL or access token | HTTPS; short access lifetime; audience/resource binding; scoped grants; rate limits; revocation | sanitized auth failures, reuse/rate anomalies | revoke grant/token family, rotate credentials, re-pair; an authorized full-shell grant remains highly powerful | DP-012–014 / R0003 |
| TM-02 | Stolen refresh token | rotation, reuse detection, secure local storage/ACL, no log exposure | token-family reuse and impossible sequence events | revoke family and require re-pair; theft before detection may allow access within policy | DP-014 / AUTH-06–07 |
| TM-03 | OAuth redirect, CSRF or authorization-code attack | exact redirect URI, state/nonce, PKCE S256, one-use short codes, issuer validation | rejected mismatch counters without sensitive values | invalidate transaction and require restart; no permissive fallback | DP-012 / AUTH-01–04 |
| TM-04 | Replay or duplicate transport request | operation ID before execution; idempotency key + fingerprint; one writer/session | duplicate/conflicting key events and reconciliation status | return existing result, conflict or UNKNOWN; never silently replay arbitrary shell side effects | DP-006 / TERM-04–07 |
| TM-05 | Command injection through structured tool fields | no shell construction for internal control operations; validate identifiers; argv-based process APIs; explicit shell capability boundary | negative contract tests, sanitized error categories | reject malformed control inputs; arbitrary text intentionally sent to a granted shell is not treated as constrained execution | DP-006–007 / R0002 |
| TM-06 | Prompt injection in terminal/file content | tool output is data; scopes/grants only change through owner-bound authorization; `confirmed=true` is not approval | attempts to mutate grants without owner flow; AUTH-08–09 tests | deny scope change; warn owner where appropriate; model behavior itself is not a host security boundary | DP-013 / R0003 |
| TM-07 | Forged PTY completion marker | completion channel independent of transcript; operation ledger | marker-forgery and large-output tests | return UNKNOWN if completion cannot be proven | DP-007 / TERM-08–09 |
| TM-08 | Path traversal or lexical escape | canonical allowed-root policy; reject `..` escape and protected roots | traversal contract tests and denied-operation events | deny operation; lexical validation alone does not remove race risk | DP-005 / FILE-05–08 |
| TM-09 | Symlink race / TOCTOU | safe OS mutation primitives, separate work identity, no-follow/dirfd strategy where supported, disable unsafe recursive cases | adversarial swap/race tests | explicit unsupported/failed result with no partial mutation; residual host-owner mutation risk documented | DP-005 / FILE-04–09 |
| TM-10 | Destructive move/replacement | never pre-delete destination; atomic no-replace; same-path guard; journal only proven complex flows | regression tests for missing source, rename failure and EXDEV | preserve both objects where commit did not succeed; unsafe replacement stays disabled | DP-001, DP-005 / FILE-01–04,09 |
| TM-11 | SSRF/DNS rebinding through attachment URL | HTTPS/source policy, DNS/IP validation at each hop, redirect revalidation, blocked private/link-local ranges, deadline/size/concurrency bounds | rejected-target/redirect/timeout metrics and SSRF fixtures | abort fetch without unrestricted fallback; verified client-contract exceptions require explicit ADR/policy | DP-003–004 / SSRF-01–08 |
| TM-12 | Download-grant leakage | opaque short lifetime, single/policy-bound use, no raw URL logging, HTTPS | canary tests across app/proxy/error logs | expire/revoke grant and rotate affected credential; client/provider may still receive an intentionally returned link | DP-011 / LOG-02,05 |
| TM-13 | Malicious or oversized attachment | strict size/time/type-independent handling, streaming to protected temporary file, expected digest when provided, optional future scanning adapter | size/digest/cancellation events and quarantine/test fixtures | abort and remove/recover temporary state; antivirus is not claimed in current releases | DP-004, DP-010, R0005 |
| TM-14 | Disk exhaustion by transcript/upload/state | quotas, minimum free-space reserve, admission control, segmented retention, separate service reserve | disk/reserve/degraded health signals | reject new writes/commands as necessary; report transcript gaps; do not silently kill live tmux solely due capture failure | DP-008, DP-010 / CUR-06, STR-03–04 |
| TM-15 | Memory exhaustion / streaming backpressure failure | bounded pipeline, concurrency caps, cancellation, output buffers and queue ceilings | RSS/queue/slow-consumer tests and health metrics | abort affected transfer/request; Session Host remains separately controlled | DP-010 / STR-01–03 |
| TM-16 | Fork bomb or process/resource abuse | restricted execution profile, no sudo/Docker socket, OS cgroup/rlimit controls where supported, explicit admin profile | cgroup/process/output pressure signals | contain/terminate according to owner policy; unrestricted host-root execution cannot be safely sandboxed by this product | DP-009–010 / STR-05 |
| TM-17 | Privilege escalation or lateral movement | separate `dp-mcp`, `dp-agent`, `dp-work`; ACL-separated secrets; minimal environment; loopback/UNIX IPC | permission tests and unexpected caller/identity events | fail closed, rotate secrets, rebuild compromised host when necessary; root compromise defeats local isolation | DP-009 / R0002 |
| TM-18 | Secret leakage in application/proxy/doctor logs | field allowlists, route templates, error-string sanitizer, access-log review, no body tracing | canary secrets through every error/export path | purge/rotate exposed credentials and fix sanitizer before release | DP-011 / LOG-01–06 |
| TM-19 | Malicious update or supply-chain compromise | immutable artifacts, signed manifest, pinned lockfile, least-privilege CI/release credentials, staged activation | signature/checksum failure, provenance/release-record checks | reject update, keep current version, rotate signing/release credentials after compromise | R0004 / OPS-05–07 |
| TM-20 | Telemetry abuse, linkage or falsified usage | opt-in off by default, strict schema, rate limits, HMAC pseudonym, no arbitrary fields, bounded retention | invalid/rate anomalies, collector health, aggregate consistency checks | drop invalid events; disclose that metrics cover telemetry-enabled installations and can be gamed | DP-015 / TEL-01–07 |
| TM-21 | Compromised Catalog Relay | no durable data-plane bodies, no body tracing/disk buffering, short scoped grants, cryptographic device identity, bounded memory | central persistence/log inspection, routing anomaly and revocation tests | disable/drain Catalog and revoke pairings; Direct remains usable; TLS-terminating Relay can see plaintext in transit | R0006 / CAT-04–07 |
| TM-22 | Cross-tenant/server routing leak | owner-bound identifiers, deny-by-default lookup, unguessable IDs, explicit server binding, tunnel fencing generation | two-owner negative tests with colliding labels/IDs | deny and revoke affected binding; incident review before pilot resumes | R0006 / CAT-01–04 |
| TM-23 | Stale or hijacked outbound tunnel | mutual cryptographic device identity, generation fencing, reconnect backoff/jitter, revocation | stale-generation and reconnect anomaly events | fence old tunnel, revoke device and re-pair | R0006 / CAT-03–05 |
| TM-24 | Multi-user Direct data leak | single-owner product boundary; OS identity boundary; do not claim multi-tenant isolation | configuration warning and owner/session authorization tests | unsupported multi-owner configuration is rejected; organization RBAC requires a future ADR/release | R0003 boundary |

## Detection and incident evidence rules

- Detection events use identifiers and categories, never raw commands, transcript text, file bodies or credentials.
- Security tests use canary secrets and disposable data only.
- A test is evidence only when linked to the exact commit, environment and result.
- A missing detector does not justify verbose sensitive logging.
- Incident response may stop admission or revoke future mutations without silently terminating unrelated live sessions.

## Review triggers

Review this threat model when:

- a new capability crosses an existing trust boundary;
- the supported execution profile gains privilege;
- a new external URL/data source is accepted;
- OAuth/client registration behavior changes;
- a central Relay or multi-owner feature is proposed;
- storage, update or release-signing design changes;
- a security incident or independent review invalidates an assumption.

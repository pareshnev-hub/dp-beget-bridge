# Audit finding traceability

Date: 2026-09-21
Status: **SOURCE OF TRUTH FOR ACCEPTANCE EVIDENCE**

This matrix links every audit finding to implementation work, required tests and its release gate. Issue closure without the linked evidence does not change implementation status to VERIFIED.

| Finding | Severity | Planning issue | Required evidence | Release gate |
|---|---:|---|---|---|
| F01 destructive move pre-delete | P0 | DP-001, DP-005 | FILE-01, FILE-02, FILE-03, FILE-09 | R0002 |
| F02 implicit root runtime | P1 | DP-009 | OPS-03 plus identity/ACL integration evidence | R0002 |
| F03 external URL fetch / SSRF | P1 | DP-004 | SSRF-01 through SSRF-08 | R0002 |
| F04 file input contract/descriptors | P1 | DP-003 | target-client contract fixture, schema/output snapshots, annotation assertions | R0002 |
| F05 stdout marker completion | P1 | DP-006, DP-007 | TERM-05, TERM-07 through TERM-09 | R0002 |
| F06 fixed completion search window | P1 | DP-007 | TERM-09 and operation-status persistence evidence | R0002 |
| F07 no single-writer/durable operations | P1 | DP-006 | TERM-04 through TERM-07 | R0002 |
| F08 retained output loses addressable metadata | P1 | DP-008 | CUR-01 through CUR-05 | R0002 |
| F09 transfer backpressure/cancellation | P1 | DP-004, DP-010 | SSRF-05 through SSRF-07, STR-01–02 | R0002 |
| F10 filesystem TOCTOU boundary | P1 | DP-005 | FILE-04 through FILE-09 | R0002 |
| F11 shell/service credential isolation | P1 | DP-009 | restricted-runner ACL test, OPS-03 | R0002 |
| F12 real tmux/systemd lifecycle unproven | P1 | DP-002, DP-009 | TERM-01 through TERM-03, TERM-10 through TERM-12 | R0002 |
| F13 missing resource ceilings | P1 | DP-008, DP-010, DP-016 | CUR-06, FILE-11, STR-01 through STR-05 plus active-session admission | R0002 |
| F14 URL/exception log leakage | P1 | DP-011 | LOG-01 through LOG-06 | R0002 |
| F15 telemetry queue can remain rejected | P2 | DP-015 | TEL-03, TEL-07 | R0004 if telemetry ships |
| F16 startup misclassified as active usage | P2 | DP-015 | TEL-01, TEL-02, TEL-06 | R0004 if telemetry ships |
| F17 unsigned update/no rollback | P2 | R0004 implementation issues | OPS-05 through OPS-09 plus signed artifact record | R0004 |
| F18 preview bearer is not final onboarding | P2 | DP-012 through DP-014 | AUTH-01 through AUTH-10 and mandatory real-client E2E | R0003 |

## Evidence record minimum

Every linked issue/PR/release record contains:

- exact commit SHA;
- test IDs and command/workflow used;
- OS, Node, systemd and tmux versions when runtime behavior is involved;
- pass/fail result and relevant bounded metrics;
- migration/rollback result when state changes;
- confirmation that evidence contains no production secret or user content.

Status mapping is maintained in `docs/IMPLEMENTATION_STATUS.md`.

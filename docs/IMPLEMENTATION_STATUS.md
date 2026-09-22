# DP Beget Bridge — Implementation Status

Date: 2026-09-22
Baseline: `ca513764712d30e120ce69644ab2f719fc3752e3`

This is the live implementation index. Architecture documents describe targets; this file records what has implementation and verification evidence.

## Status vocabulary

- **PLANNED:** accepted work exists, implementation has not started.
- **IN PROGRESS:** a branch/PR exists; acceptance is incomplete.
- **IMPLEMENTED:** code is merged, but every required acceptance environment may not be proven.
- **VERIFIED:** acceptance evidence for the exact merged commit satisfies the issue/release gate.
- **BLOCKED:** progress requires a named external decision, permission or environment.
- **DISABLED:** unsafe/incomplete capability is intentionally unavailable.

Only links to merged code, tests, CI/runtime evidence and release records can advance status. Chat statements and issue titles are not evidence.

## Release status

| Release | Status | Evidence / next gate |
|---|---|---|
| R0001 / 0.1.x technical preview | IMPLEMENTED | 12 preview tests pass; not public-ready; audit baseline `f22032e` |
| R0002 Core Safety & Persistent Runtime | IN PROGRESS | DP-001, DP-002, DP-004–DP-009 and DP-011 verified; DP-003 is implemented with real-client evidence pending; complete DP-010 and remaining release gates |
| R0003 Working Direct / Private Beta | PLANNED | requires verified R0002 and real-client OAuth/E2E evidence |
| R0004 Public Direct 1.0 | PLANNED | requires verified R0003, reproducible lifecycle and independent security gate |
| R0005 Large Transfer Hardening | PLANNED | requires R0004 and bounded transfer-state design |
| R0006 Optional Catalog Transport Pilot | PLANNED | requires dated feasibility decision; Relay not yet authorized by roadmap |
| R0007 Catalog Submission & Measured Scale | PLANNED | requires verified pilot and current official submission review |

## First implementation queue

| Planning ID | GitHub | Priority | Release | Status | Verification gate |
|---|---:|---:|---:|---|---|
| DP-001 Prevent destructive move pre-delete | #1 | P0 | R0002 | VERIFIED | `e220903`; FILE-01/02/03/09; main CI run 35616705022 |
| DP-002 Source-linked baseline and real runtime CI | #2 | P1 | R0002 | VERIFIED | `aab7a90`; PR #21; TERM-01/02/03/10/12; main CI run 35619553887 |
| DP-003 Align file schemas/descriptors | #3 | P1 | R0002 | IMPLEMENTED | `82650ea`; PR #33; contract fixture, 26/26 tests, Beget live descriptor/call smoke; main CI run 35643759663; real ChatGPT `clientInfo` capture pending |
| DP-004 Bound file fetch / SSRF | #4 | P1 | R0002 | VERIFIED | `d3e3ab0`; PR #35; CI run 35647006053; SSRF-01…08 and 13/13 focused tests; exact-commit Beget Node 22 lifecycle, ACL, policy-limit and loopback evidence |
| DP-005 Safe workspace mutations | #5 | P1 | R0002 | VERIFIED | `3de6fce`; FILE-01…09, 20/20 focused tests, symlink-boundary canary and exact-commit Beget mutation smoke |
| DP-006 Single-writer operation ledger | #6 | P1 | R0002 | VERIFIED | `1dafc76`; TERM-04…07, migration/backup recovery, SQLite integrity and exact-commit Beget operation-ledger smoke |
| DP-007 Completion independent of PTY | #7 | P1 | R0002 | VERIFIED | `f9e35e0`; PRs #41–#46; TERM-07/08/09, transcript-removal and `exec` ambiguity; focused and full lifecycle smoke on Beget; CI run 35670994139 |
| DP-008 Archived output/cursor integrity | #8 | P1 | R0002 | VERIFIED | `419a7dd`; PR #49; schema v1→v2 with backup/integrity proof; CUR-01…06, 9/9 focused tests and exact-commit Beget CLOSED-transcript restart smoke |
| DP-009 Runner lifetime/credential separation | #9 | P1 | R0002 | VERIFIED | `386b083`; PRs #27–29; TERM-01/02/03/10/11/12, OPS-03, identity/ACL and restart evidence on Beget; main CI run 35639678847 |
| DP-010 Backpressure/disk ceilings | #10 | P1 | R0002 | PLANNED | STR-01…05 |
| DP-011 Log/diagnostic credential safety | #11 | P1 | R0002 | VERIFIED | `2685e67`; PR #31; LOG-01…06, live journald canary and lifecycle smoke on Beget; main CI run 35641471859 |
| DP-012 OAuth discovery/registration spike | #12 | P1 | R0003 | PLANNED | AUTH-01…03 + real client |
| DP-013 Owner consent/grants | #13 | P1 | R0003 | PLANNED | AUTH-04/08/09 |
| DP-014 Refresh/revoke/re-pair | #14 | P1 | R0003 | PLANNED | AUTH-05…07/10 |
| DP-015 Analytics correctness/recovery | #15 | P2 | R0004 | PLANNED | TEL-01…07; runtime unaffected while OFF |

## Updating this file

For each status change, add links in the related issue/PR and update:

1. status;
2. merged commit SHA;
3. CI/integration evidence;
4. migration/rollback evidence when applicable;
5. remaining limitations.

Do not mark a release VERIFIED merely because all issue numbers are closed; evaluate the release gate in `docs/ROADMAP.md` and traceability matrix.

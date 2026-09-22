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
| R0002 Core Safety & Persistent Runtime | VERIFIED | All included DP items verified; exact Beget runtime and actual ChatGPT file-contract evidence recorded for `41db306` through the outbound-only private acceptance tunnel; no public listener or Traefik change |
| R0003 Working Direct / Private Beta | IN PROGRESS | DP-012 local OAuth compatibility implementation exists; real-client OAuth/E2E evidence remains required |
| R0004 Public Direct 1.0 | PLANNED | requires verified R0003, reproducible lifecycle and independent security gate |
| R0005 Large Transfer Hardening | PLANNED | requires R0004 and bounded transfer-state design |
| R0006 Optional Catalog Transport Pilot | PLANNED | requires dated feasibility decision; Relay not yet authorized by roadmap |
| R0007 Catalog Submission & Measured Scale | PLANNED | requires verified pilot and current official submission review |

## First implementation queue

| Planning ID | GitHub | Priority | Release | Status | Verification gate |
|---|---:|---:|---:|---|---|
| DP-001 Prevent destructive move pre-delete | #1 | P0 | R0002 | VERIFIED | `e220903`; FILE-01/02/03/09; main CI run 35616705022 |
| DP-002 Source-linked baseline and real runtime CI | #2 | P1 | R0002 | VERIFIED | `aab7a90`; PR #21; TERM-01/02/03/10/12; main CI run 35619553887 |
| DP-003 Align file schemas/descriptors | #3 | P1 | R0002 | VERIFIED | `82650ea`; PR #33; contract fixture and Beget smoke; actual ChatGPT list/upload/download acceptance on `41db306`; immediate peer recorded as pinned `tunnel-client` because the tunnel does not forward a separate ChatGPT build |
| DP-004 Bound file fetch / SSRF | #4 | P1 | R0002 | VERIFIED | `d3e3ab0`; PR #35; CI run 35647006053; SSRF-01…08 and 13/13 focused tests; exact-commit Beget Node 22 lifecycle, ACL, policy-limit and loopback evidence |
| DP-005 Safe workspace mutations | #5 | P1 | R0002 | VERIFIED | `3de6fce`; FILE-01…09, 20/20 focused tests, symlink-boundary canary and exact-commit Beget mutation smoke |
| DP-006 Single-writer operation ledger | #6 | P1 | R0002 | VERIFIED | `1dafc76`; TERM-04…07, migration/backup recovery, SQLite integrity and exact-commit Beget operation-ledger smoke |
| DP-007 Completion independent of PTY | #7 | P1 | R0002 | VERIFIED | `f9e35e0`; PRs #41–#46; TERM-07/08/09, transcript-removal and `exec` ambiguity; focused and full lifecycle smoke on Beget; CI run 35670994139 |
| DP-008 Archived output/cursor integrity | #8 | P1 | R0002 | VERIFIED | `419a7dd`; PR #49; schema v1→v2 with backup/integrity proof; CUR-01…06, 9/9 focused tests and exact-commit Beget CLOSED-transcript restart smoke |
| DP-009 Runner lifetime/credential separation | #9 | P1 | R0002 | VERIFIED | `386b083`; PRs #27–29; TERM-01/02/03/10/11/12, OPS-03, identity/ACL and restart evidence on Beget; main CI run 35639678847 |
| DP-010 Backpressure/disk ceilings | #10 | P1 | R0002 | VERIFIED | `0796e74`; PRs #51–#52; STR-01…05 plus 28/28 focused tests; exact-commit Beget limits, completion/lifecycle, doctor, identity and loopback evidence |
| DP-011 Log/diagnostic credential safety | #11 | P1 | R0002 | VERIFIED | `2685e67`; PR #31; LOG-01…06, live journald canary and lifecycle smoke on Beget; main CI run 35641471859 |
| DP-016 Residual R0002 file/session gates | #54 | P1 | R0002 | VERIFIED | `cc25961`; PRs #55–#56; FILE-10/11 deterministic cleanup/preservation; FILE-12 explicitly N/A; CI run 35703730372; exact-commit Beget 8+1 concurrent admission, `session_limit`, cleanup, lifecycle, doctor and loopback evidence |
| DP-017 Private real-client compatibility tunnel | #58 | P1 | R0002 | VERIFIED | `41db306`; PRs #59–#62; actual ChatGPT `list_files`, upload and download calls; sanitized immediate `tunnel-client` identity; core/tunnel doctors and loopback-only Beget evidence; no Traefik change |
| DP-012 OAuth discovery/registration spike | #12 | P1 | R0003 | IN PROGRESS | local CIMD/PKCE/resource implementation and tests; real ChatGPT evidence pending |
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

# DP Beget Bridge — Implementation Status

Date: 2026-09-23
Baseline: `adb01e1bf9c02d3bad72f1d27796825fdeec4f77`

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
| R0003 Working Direct / Private Beta | IN PROGRESS (formal gate) | DP-012, DP-013 and DP-014 verified; #80 records the real-client OAuth terminal/file acceptance at `971d67a`. Link the release-wide AUTO-01…04 and N/N-1 evidence before changing this row to VERIFIED. |
| R0004 Public Direct 1.0 | IN PROGRESS | #87 is the release queue; #88–#104 merged as artifact, trust-key, preflight, staging, extraction, dependencies, version promotion, pointer, backup/restore and admission primitives. No public install/update/rollback gate is yet accepted. |
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
| DP-012 OAuth discovery/registration spike | #12 | P1 | R0003 | VERIFIED | `35ec4d8`; PR #66; CI 35768749994; real ChatGPT DCR consent and `list_files`; three read tools only; staging constraints in `docs/OAUTH_SPIKE.md` |
| DP-013 Owner consent/grants | #13 | P1 | R0003 | VERIFIED | `0625a79`; PRs #68–#73; AUTH-04/08/09; live OAuth `list_files` and signed Agent context |
| DP-014 Refresh/revoke/re-pair | #14 | P1 | R0003 | VERIFIED | `4738635`; PRs #74–#78; AUTH-05…07/10; CI runs 35790732466, 35791425640, 35791923413, 35792275181 and 35792676446; Beget schema v1→v2, live rotation/reuse/revocation smoke and real ChatGPT OAuth `list_files` |
| DP-015 Analytics correctness/recovery | #15 | P2 | R0004 | PLANNED | TEL-01…07; runtime unaffected while OFF |

## R0004 implementation slices (not release acceptance)

| Slice | Merged commit | Evidence / remaining boundary |
|---|---|---|
| Signed candidate verification | `80c98af` (#88) | Ed25519 manifest verification; tampered bytes and wrong-key tests |
| Exact-commit build and offline signing | `ec0175e` (#89) | Repeatable archive on the supported toolchain; key generation/custody and public trust distribution pending |
| Private staging and re-verification | `c8daf52` (#90) | Copied bytes checked again; no installer enforcement yet |
| Read-only host preflight | `1d79f4e` (#91) | Ubuntu 24.04, DNS/TLS checks; live Beget OS/dependency probe passed, DNS/TLS pending |
| Quarantine extraction | `2e6316d` (#92) | Signed link/traversal rejection before write; no service activation |
| Atomic version pointer | `0d5dba8` (#93) | Health failure restores old pointer in tests; no systemd orchestration or crash recovery |
| SQLite migration backup | `a5c1f92` (#94) | WAL snapshot and integrity tests; no multi-store freeze/restore wiring |
| Private configuration backup | `b770256` (#95) | Secret-preserving file copy; no restore wiring |
| Private backup restore | `ff9b7ca` (#97) | Manifest inventory/hash checks; standalone SQLite copies; new-directory restore only, no service rollback wiring |
| Root trust anchor and quarantine preparation | `74b1e72` (#98) | Independent key fingerprint, root-only no-replace pin, signed staged/extracted bytes; production key custody, installer and service activation pending |
| Private dependency installation | `e87de56` (#100) | Signed lockfile, npm lifecycle scripts disabled, isolated cache, real dependency CI; no running service change |
| Inert versioned promotion | `a186133` (#101) | Rechecks signed source and dependency links; moves release into versioned root; no activation or rollback orchestration |
| Read-only managed service preflight | `63a25b2` (#102) | Requires already-versioned healthy services and tmux-safe Session Host; current R0003 mutable layout needs separate migration |
| Grouped stopped-state snapshot | `749ee1a` (#103) | Root-only config and multi-DB copy/restore; no live state replacement or service orchestration |
| Persistent admission gate | `adb01e1` (#104) | MCP, Agent and Session Host refuse non-health requests under root-owned flag; no updater resume wiring yet |

The fifteen slices above are merged code, **not** a 1.0.0 release. The package version remains 0.1.0. OPS-01…09, the supported install/update/rollback matrix, retention/quotas, public documentation and independent security review are still open. The running Beget R0003 deployment has not been replaced by this R0004 work.

## Updating this file

For each status change, add links in the related issue/PR and update:

1. status;
2. merged commit SHA;
3. CI/integration evidence;
4. migration/rollback evidence when applicable;
5. remaining limitations.

Do not mark a release VERIFIED merely because all issue numbers are closed; evaluate the release gate in `docs/ROADMAP.md` and traceability matrix.

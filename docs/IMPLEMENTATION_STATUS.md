# DP Beget Bridge — Implementation Status

Date: 2026-09-23
Baseline: `f1a9b553500af1326cf2c8604a10b6f254d51598`

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
| R0004 Public Direct 1.0 | IN PROGRESS | #87 is the release queue; implementation slices through #146 cover signed artifacts, trust, backups, guarded first-migration phases, reverified pre-exposure recovery staging and journaled candidate stop. The public install/update/rollback gate is still open. |
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
| Read-only host preflight | `1d79f4e` (#91) | Ubuntu 24.04; live OS/dependency probe passed; R0003 OAuth hostname DNS/TLS/issuer checked separately in `docs/R0004_LIVE_INVENTORY.md`; R0004 preflight script not yet run on Beget |
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
| Read-only admission drain | `b5ea60f` (#105) | Health exposes paused state and in-flight count; bounded local probe rejects incomplete drain; durable operation preflight still separate |
| Legacy systemd-unit snapshot | `f1a9b55` (#106) | Exact R0003 unit fragments and OAuth drop-in; no live unit replacement or first-migration rollback |
| Dedicated ingress-unit snapshot | `62a6a63` (#109) | Includes OAuth proxy socket/service and tunnel fragments with layout checks; no live guard installation or service change |
| Persistent ingress boot guard staging | `98c7545` (#110) | Root-only guard drop-ins for proxy socket/service and tunnel; no live installation or journaled close yet |
| Migration phase journal | `f5e7b60` (#111) | Root-only synced phase updates and exclusive transition lock; expanded with snapshot and service evidence in #116, #117 and #120 |
| Read-only interrupted-migration assessment | `683092b` (#112) | Classifies orphaned marker/lock and incomplete phases; never authorizes reopening ingress |
| Loaded ingress guard preflight | `b149851` (#114) | Requires exact three systemd drop-ins loaded; no live guard installed |
| Synced unit backup and verification | `f2bbaf3` (#115) | Root-only complete inventory/hash proof before journal binding |
| Journal-bound unit snapshot | `5300e4a` (#116) | v2 journal refuses changed or incomplete unit snapshot |
| Recorded legacy service activity | `86c07d9` (#117) | v3 journal saves seven-unit activity; requires active core and ingress |
| Closed legacy ingress phase | `ebfb3d0` (#118) | Marker before socket/service/tunnel stops; isolated root CI; public route exclusivity still unproven |
| Legacy writer quiescence phase | `54c2f7a` (#119) | Ledger check before Session Host stop; independent R0003 request-drain proof still required |
| Journal-bound grouped state snapshot | `df2047b` (#120) | v4 journal records config/SQLite bundle-manifest digest; full restore gate pending |
| Managed unit staging and loaded check | `de4e501` (#121) | Four version-link drop-ins and tmux-safe KillMode check; no live unit change |
| Journaled managed unit installation | `f8ed61d` (#122) | Isolated closed-ingress unit install and daemon-reload with fail-closed state; no pointer activation or recovery wiring |
| Durable version pointer | `212dcf9` (#124) | Directory fsync and activation lock retained if rollback is uncertain |
| Managed candidate activation | `ac5ae9a` (#125) | Starts four services under paused admissions and closed ingress; stops candidate and restores pointer on failed local health, not grouped state |
| Guarded ingress release | `ba48203` (#126) | Journal intent precedes marker removal; requires exclusive route proof and public pause response; never rewinds after possible exposure |
| Fixed public admission probe | `9bf38ea` (#127) | HTTPS `/mcp` requires exact `503 admission_paused` JSON; route exclusivity remains independent |
| Verified pre-exposure recovery staging | `167bf36` (#128) | Fully checks grouped restore in a new directory with ingress closed; does not replace live state |
| Bound snapshot source paths | `2e0dcc3` (#129) | Private v2 grouped manifest records config and database origins; no live restore controller |
| Bound SQLite ownership | `b266751` (#130) | SQLite v2 manifest records source UID/GID/mode; restored private copies preserve ownership |
| Writer reboot guard staging | `96b3bf2` (#131) | Four service guards block reboot starts under persistent marker without ephemeral permit |
| Loaded writer guard preflight | `573b3e1` (#132) | Closure requires all writer guards loaded and absent permit before marker creation |
| Managed writer guard compatibility | `af85fce` (#133) | Managed app binding installation accounts for exact writer guard drop-ins |
| Scoped candidate writer permit | `4f86fc5` (#134) | Ephemeral startup permit encloses ordered starts and local health; ingress release rejects leftover permit |
| Journaled seven-unit guard install | `3055e21` (#135) | Staged guard install, sync, reload and loaded preflights; no live Beget change |
| Guards through stopped-state snapshot | `11fca72` (#136) | Quiescence and grouped snapshot verify loaded writer guards and absent permit; independent legacy drain proof still required |
| Writer guard recovery staging | `e0ea1d4` (#137) | Pre-exposure staging rechecks loaded writer guards and absent permit, and removes staged state on change |
| Live recovery destination preflight | `d2d193c` (#138) | Read-only path, ownership, inventory and SQLite sidecar checks; no live state replacement |
| Root CI destination gate | `2c1c617` (#139) | Runs destination preflight tests with root privileges in systemd CI |
| Original unit recovery staging | `4c6fc31` (#140) | Recreates bound original fragments and drop-ins in a new private directory; no live unit change |
| Matched pre-exposure recovery pair | `b983afb` (#141) | Stages state and original units together and rechecks closed ingress; no live rollback controller |
| Real systemd guard lifecycle | `5e3dabe` (#142) | CI checks loaded guard conditions on disposable ingress and writer services; no Beget mutation |
| Recovery pair destination binding | `cfd1ba6` (#143) | Stages original state and units only when live data topology still matches; no live replacement |
| Recovery pair re-verification | `c241459` (#144) | Reopens staged config, SQLite and original units against bound manifests and closed ingress; no live replacement |
| Durable pre-exposure rollback intent | `60d4d31` (#145) | Root-owned prepared record binds migration, staged pair and live destination inodes; no live replacement |
| Candidate rollback stop | `0830fcc` (#146) | Journaled writer stops under pause and marker; retained tmux and ledger rechecked; no live state replacement |
| Original unit view restoration | `65706e7` (#147) | Journaled removal of managed bindings with original fragments and boot guards intact; no live state replacement |
| Original view recovery proof | `c16d529` (#148) | Reopens restored unit view, stop intent and staged pair under original guards; no live state replacement |
| Destination-local old-state copies | `d8c64c2` (#149) | Journaled, synced config and SQLite copies beside live destinations; no live rename |
| Interrupted replacement ledger | `5d722aa` (#150) | Records inode positions and content for a future resumable live swap; no live rename |
| Resumable old-state replacement | `cf061f3` (#151) | Journaled config/SQLite renames retain candidate bytes and resume recognized positions; no old-service restart |
| Candidate pointer deactivation | `81f2a44` (#152) | Removes only first-migration `current` after old state replacement; leaves ingress marker and writers stopped |
| Original writer restart | `0da1f68` (#153) | Starts R0003 under closed ingress and scoped permit, requires exact legacy local health; no public reopening |
| Legacy ingress reopening | `9a27ce4` (#154) | Journals possible public exposure before removing marker; failed public proof recloses ingress and forbids snapshot rewind; route proof still missing |
| Fixed public R0003 OAuth proof | `97eb185` (#155) | Bounded HTTPS challenge at fixed hostname after old-service restart; exclusive Traefik route proof still missing |
| Cross-process state recovery | `83ef40f` (#156) | A separate process dies after either config rename; resumed rollback verifies durable ledger, old SQLite and parked candidate bytes; no full systemd transaction |
| Cross-process pointer recovery | `116b834` (#157) | A separate process dies after candidate `current` unlink; resumed journal syncs the directory with ingress still closed |
| Seven-unit systemd boundary | `9c1d383` (#159) | CI snapshots, guards, closes dedicated ingress and quiesces four inert services under the persistent marker on a disposable runner; candidate switch and rollback still untested end to end |

These sixty-six slices are merged code, **not** a 1.0.0 release. The package version remains 0.1.0. OPS-01…09, the supported install/update/rollback matrix, retention/quotas, public documentation and independent security review are still open. The running Beget R0003 deployment has not been replaced by this R0004 work.

## Updating this file

For each status change, add links in the related issue/PR and update:

1. status;
2. merged commit SHA;
3. CI/integration evidence;
4. migration/rollback evidence when applicable;
5. remaining limitations.

Do not mark a release VERIFIED merely because all issue numbers are closed; evaluate the release gate in `docs/ROADMAP.md` and traceability matrix.

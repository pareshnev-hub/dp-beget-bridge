# DP Beget Bridge — Release Process

Date: 2026-09-21

## Definitions

**BUILD** — CI result for one exact commit SHA. A green BUILD is not automatically a release.

**RELEASE** — approved immutable version with artifacts, checksums/signatures where required, release notes, migration notes and acceptance evidence.

**DEPLOYMENT** — installation of one RELEASE into a specific environment.

## Versioning

Use semantic product versions plus release milestones in documentation:
- R0001 = existing technical preview / 0.1.x line;
- R0002 = core safety / proposed 0.2.0;
- R0003 = working Direct private beta / proposed 0.3.0;
- R0004 = public Direct / 1.0.0;
- later milestones follow ROADMAP.

Never rewrite an existing Git tag. If the repository already contains a conflicting tag/version, document the adjustment before release.

## Build gate

Every build records:
- commit SHA;
- Node version;
- OS;
- dependency lockfile;
- unit/contract tests;
- integration-test results where applicable.

## Release gate

A release is cut only when:
1. milestone Definition of Done is satisfied;
2. required security/test gates are linked;
3. migrations are documented;
4. rollback path is documented;
5. known limitations are explicit;
6. changelog/release notes match actual code status.

## Artifacts

Public 1.0 requires immutable release artifacts.

Target flow:
1. CI builds release artifact.
2. Generate manifest with version, commit, files and cryptographic digests.
3. Sign manifest/artifact with a documented trust key.
4. Publish artifact + checksum/signature.
5. Installer downloads versioned artifact.
6. Installer verifies trust before executing anything.

Do not install directly from mutable `main` for public releases.

## Deployment model

Target updater:
1. download verified artifact;
2. prepare a new version directory;
3. preserve config/state backup;
4. run forward migration with preflight;
5. start/readiness-check new version without destroying live Session Host state;
6. atomically switch active version;
7. retain previous compatible version for rollback.

MCP/Agent updates must not implicitly terminate live terminal processes.

## Database/state migrations

Each schema migration has:
- version ID;
- preconditions;
- forward step;
- backup/restore note;
- compatibility window;
- failure behavior.

Do not silently downgrade a state schema if N-1 cannot safely read it.

## Rollback

Rollback may restore service code/configuration. It does **not** promise to:
- restore files deleted by user commands;
- resurrect arbitrary processes lost after OS reboot;
- undo external side effects produced by shell commands.

If an operation outcome is uncertain, report UNKNOWN rather than replaying it.

## Production deployment log

For each production/staging deployment record:
- environment;
- timestamp;
- release version;
- commit SHA;
- migration versions;
- operator/automation identity;
- readiness result;
- rollback result if used.

Do not put credentials or terminal content in deployment logs.

## Hotfix

P0/P1 safety hotfixes may be released as patch versions before the next roadmap milestone if:
- regression test reproduces the defect;
- fix is focused;
- CI passes;
- migration/rollback risk is documented.

Known data-loss behavior must not be re-enabled merely to simplify rollback.

# Work handoff — DP Beget Bridge

Date: 2026-09-21

## Source of truth

Read in this order:
1. `docs/ROADMAP.md`
2. `docs/ARCHITECTURE.md`
3. `docs/audit/AUDIT-2026-09-21.md`
4. `docs/audit/FIRST_SPRINT.md`
5. `docs/audit/TEST_MATRIX.md`
6. `docs/audit/TRACEABILITY.md`
7. `docs/THREAT_MODEL.md`
8. `docs/IMPLEMENTATION_STATUS.md`
9. `docs/RELEASE_PROCESS.md`
10. `docs/PRIVACY_DECISIONS.md`
11. `docs/adr/`

The working baseline audited was:
`f22032ec6c465f0eeffec6c360959d266941ea29`.

The documentation commit/merge after this audit may be newer; implementation work should branch from current `main`.

## Immediate work

Start with the GitHub issue carrying planning ID **DP-001**.

Do not start by implementing a Relay or a large OAuth subsystem.

First make the runtime safe:
- data-loss regression;
- real tmux/systemd integration;
- file contract/SSRF;
- operation ledger/concurrency;
- transcript/cursor integrity;
- execution-secret separation;
- backpressure/resource ceilings;
- log sanitization.

## Working rule

For each issue:
1. reproduce/test;
2. implement the smallest correct change;
3. run CI/integration evidence;
4. update docs if semantics changed;
5. link PR/commit/evidence to issue;
6. close only when acceptance criteria are satisfied.

Every implementation issue/PR must state affected files, required test IDs, security considerations, migration/rollback behavior and exact acceptance evidence. Update `docs/IMPLEMENTATION_STATUS.md` only when linked evidence supports the new status.

Do not silently change fundamental architecture. Use ADR + PR for such changes.

## Important corrections from earlier discussion

- This is a Linux VPS MCP bridge, not a Windows desktop/remote-control project.
- Direct Mode is the primary architecture.
- Central website/telemetry/feedback are not runtime dependencies.
- Catalog Relay is optional and comes after a current distribution feasibility check.
- MAC address is never a security identity.
- No root-by-default.
- Full shell rights must be disclosed honestly; separate file-tool scopes cannot constrain an unrestricted shell beyond OS rights.
- "timeout" means stop waiting, not kill the session.
- "exactly once" is not promised for arbitrary shell side effects.
- telemetry-enabled installation counts are not exact human-user counts.

## What Work should not assume is already tested

Unless an issue/PR contains evidence, do not assume:
- real Beget VPS tmux/systemd persistence;
- production TLS/OAuth E2E;
- ChatGPT/Codex client-registration compatibility;
- large-transfer memory safety;
- Catalog multi-tenant isolation;
- updater rollback correctness.

The roadmap intentionally requires evidence before these statuses become DONE.

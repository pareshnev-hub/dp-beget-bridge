# Contributing

Issues and pull requests are welcome. Keep changes modular and backward
compatible with the published capability contract.

Implementation work follows `docs/ROADMAP.md`, `docs/audit/FIRST_SPRINT.md`
and `docs/audit/TRACEABILITY.md`. Fundamental architecture changes require an
ADR before implementation. Do not close an issue or mark a release VERIFIED
without exact-commit test/runtime evidence.

Before submitting:

```bash
npm ci
npm run check
npm test
```

Never include production tokens, terminal transcripts, file contents, or user
telemetry samples. New telemetry fields require a schema change, documentation
update, privacy review, and changelog entry.

Every implementation PR must identify:

- planning issue and release gate;
- affected modules and explicit non-goals;
- named test-matrix cases;
- security/privacy impact;
- migration and rollback/safe-disable behavior;
- exact CI/integration evidence without production secrets or user content.

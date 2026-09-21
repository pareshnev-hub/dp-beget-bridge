# Contributing

Issues and pull requests are welcome. Keep changes modular and backward
compatible with the published capability contract.

Before submitting:

```bash
npm ci
npm run check
npm test
```

Never include production tokens, terminal transcripts, file contents, or user
telemetry samples. New telemetry fields require a schema change, documentation
update, privacy review, and changelog entry.

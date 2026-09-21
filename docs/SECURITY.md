# Security model

DP Beget Bridge executes commands and moves files on a user's server. Treat
the agent token as an administrator credential for the configured scope.

## RELEASE 0001 implemented safeguards

- the agent listens on loopback by default;
- every agent request requires a bearer token;
- file paths must stay inside configured allowed roots;
- uploads use a protected temporary file followed by rename, but no-replace race safety and broader mutation semantics are not yet release-verified;
- overwrite and delete are explicit operations;
- terminal sessions are named with generated identifiers;
- secrets are never committed to the repository;
- the MCP layer declares tool annotations, but their accuracy and the actual target-client file contract remain an R0002 verification item;
- symlink traversal outside allowed roots is rejected.
- telemetry has a code-level field allowlist and is disabled by default.
- operational logs use a field allowlist and fixed route templates; raw request URLs, exception text, commands, file paths and credentials are excluded.

## Known technical-preview blockers

The current preview must not be described as a safe public connector. Open blockers include:

- destructive destination pre-delete in the current move implementation;
- incomplete TOCTOU/no-replace mutation protection;
- stdout-marker-based command completion and no durable single-writer operation ledger;
- unproven real tmux/systemd persistence behavior;
- incomplete work/service credential separation and possible implicit root runtime;
- external attachment fetch is restricted by the versioned policy in
  `ATTACHMENT_FETCH_POLICY.md`; DP-004 verification evidence must remain linked
  before public exposure;
- missing hard transcript/disk/output ceilings;

The authoritative finding-to-test mapping is `docs/audit/TRACEABILITY.md`.

## Direct public release requirements

- HTTPS on the user's own connector hostname;
- OAuth/OIDC-compatible Authorization Code flow with PKCE S256, issuer/resource/audience validation and a client-registration mode proven against the actual target client;
- generated recovery/setup secret and revocation;
- owner-bound approval or an explicit constrained unattended grant for dangerous actions; a model-supplied confirmation field is never human authorization;
- published privacy policy and security contact.

## Optional Catalog mode requirements

- OAuth 2.1 and per-user/per-server authorization;
- outbound-only agent connection to the relay;
- encrypted transport;
- short-lived pairing codes and revocation;
- local redaction of common secret formats;
- no central command, output, path, filename, or file-content retention.

## Reporting

Do not publish exploitable details in a public issue. Use the security contact
listed in the future public plugin entry.

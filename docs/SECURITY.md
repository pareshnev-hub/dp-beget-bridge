# Security model

DP Beget Bridge executes commands and moves files on a user's server. Treat
the agent token as an administrator credential for the configured scope.

## RELEASE 0001 safeguards

- the agent listens on loopback by default;
- every agent request requires a bearer token;
- file paths must stay inside configured allowed roots;
- uploads use temporary files followed by atomic rename;
- overwrite and delete are explicit operations;
- terminal sessions are named with generated identifiers;
- secrets are never committed to the repository;
- the MCP layer marks state-changing and destructive tools accurately.
- symlink traversal outside allowed roots is rejected.
- telemetry has a code-level field allowlist and is disabled by default.

## Direct public release requirements

- HTTPS on the user's own connector hostname;
- OAuth 2.1 with PKCE and dynamic client registration;
- generated recovery/setup secret and revocation;
- explicit user confirmation for destructive actions;
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

# Roadmap

This is an editable plan, not a frozen feature contract.

## RELEASE 0001 — direct persistent foundation

- persistent `tmux` terminal sessions and reconnect;
- terminal output cursors, interactive input, explicit stop/close;
- file list, upload, download, copy, move, and delete;
- local authenticated agent API and direct MCP endpoint;
- safe path roots and short-lived download links;
- opt-in privacy-preserving usage telemetry;
- automated tests and systemd installation assets.

## RELEASE 0002 — one-command Direct setup

- local OAuth 2.1 with PKCE and dynamic client registration;
- automatic TLS and configuration validation;
- guided domain/DNS setup and generated connector URL;
- signed update channel with rollback;
- session transcript segmentation and retention controls;
- installation/download statistics and feedback endpoint.

## RELEASE 0003 — optional Catalog mode

- outbound agent relay with heartbeat and automatic reconnect;
- account-to-server pairing and multiple servers per user;
- short-lived scoped grants;
- public fixed MCP endpoint for catalog submission;
- central-service migration and dual-run cutover tooling.

## RELEASE 0004 — transfer hardening

- chunked resumable transfers and directory synchronisation;
- server-to-server transfers;
- bandwidth limits and transfer progress;
- optional antivirus/content-scanning adapter.

## Future capability modules

- Docker and Compose operations;
- Git repository workflows;
- database maintenance;
- backup and restore workflows;
- scheduled jobs;
- organisation policies and role-based access.

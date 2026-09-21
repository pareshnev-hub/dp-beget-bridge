# DP Beget Bridge — Privacy and Telemetry Decisions

Date: 2026-09-21

## Direct-mode privacy principle

Direct execution runs between the MCP client and the user's VPS. DP central services are not required to execute commands, read terminal output or transfer files.

Sensitive data-plane content remains on the user VPS and is returned to the chosen client.

Do not overstate this as "nobody else can see the data": the selected MCP/client platform receives content necessary to perform the requested work.

## Centrally prohibited by default

Central DP services must not intentionally store:
- terminal command text;
- terminal stdout/stderr;
- clipboard contents;
- file bodies;
- file paths or filenames as product analytics;
- bearer/refresh tokens;
- OAuth authorization codes;
- passwords/API keys;
- ChatGPT conversation IDs;
- MCP endpoint/hostname as analytics identifiers.

## Local terminal continuity data

Transcript data is sensitive local user data.

It may be stored locally to support:
- reconnect;
- independent readers/cursors;
- closed-session archive;
- recovery after API restart.

It requires:
- local ACLs;
- retention/quotas;
- explicit purge;
- documented disk behavior.

## Telemetry

Telemetry is **opt-in and disabled by default**.

Runtime must make zero central telemetry requests when disabled.

Permitted telemetry should remain a strict allowlist of coarse fields such as:
- schema version;
- pseudonymous installation identifier;
- product version;
- platform family;
- CPU architecture;
- coarse duration/size bucket;
- event time;
- coarse event type.

Do not add arbitrary metadata pass-through.

## Active usage definition

A meaningful active installation performs a terminal or file action.

The following alone are not active product use:
- service start;
- heartbeat;
- empty polling;
- automatic update check.

Recommended labels:
- telemetry-enabled installations;
- daily active telemetry-enabled installations;
- weekly active telemetry-enabled installations;
- monthly active telemetry-enabled installations;
- Catalog accounts/devices, once Catalog exists.

Do not claim an exact number of people from installation telemetry.

## Installation identifier

A random installation ID transformed by keyed HMAC is **pseudonymous**, not guaranteed anonymous.

Do not silently link it to feedback identity, email, account or external datasets.

## Retention

Telemetry retention must be enforced periodically, not only at startup.

The current design target is a finite retention window (initially 90 days) that is documented in privacy materials and can be changed only with matching code/docs.

## Feedback

Feedback text is intentionally user-supplied and may contain accidental secrets despite warnings.

Feedback UI should:
- warn users not to paste credentials;
- make name/email/country optional;
- attach installation/product diagnostics only with separate consent;
- show what diagnostics will be sent;
- support ticket status and deletion/retention;
- avoid automatic terminal/file-content attachment.

## IP addresses

Infrastructure may necessarily observe network addresses in transit/proxy layers. Do not market this as "IP is never processed."

Product design should avoid intentionally persisting IP for analytics unless there is a documented security/operational reason and matching disclosure/retention.

VPS IP/geolocation describes hosting infrastructure and must not be presented as the user's country.

## Logs

Operational logs use an allowlist and sanitized errors.

Never log full download-grant URLs. Redaction based only on JSON key names is insufficient because secrets can occur inside:
- URL paths;
- query strings;
- exception messages;
- proxy access logs.

## Catalog Relay

If a future Relay terminates TLS, it can see data-plane plaintext in memory while routing.

The privacy promise should be:
- no intentional durable storage of commands/output/file bodies;
- no body tracing;
- no disk buffering/dumps by default;
- bounded transit memory.

Do not describe such Relay as zero-knowledge without additional end-to-end encryption.

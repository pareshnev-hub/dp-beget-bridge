# DP Beget Bridge — Test Matrix

Date: 2026-09-21

This matrix is release evidence guidance. A test is not considered passed until the issue/PR links to an actual run against the relevant commit and environment.

## Terminal / Session Host

| ID | Scenario | Expected |
|---|---|---|
| TERM-01 | start long command, MCP wait ends | process remains alive |
| TERM-02 | restart MCP during long command | process remains alive; output readable after reconnect |
| TERM-03 | restart Agent during long command | process remains alive; state reconciles |
| TERM-04 | two concurrent managed commands in one session | single-writer policy: BUSY or explicit bounded queue |
| TERM-05 | retry same idempotency key after lost response | same operation returned; no duplicate process |
| TERM-06 | same idempotency key with different payload | conflict |
| TERM-07 | crash between accepted and spawn | UNKNOWN/reconciliation; no silent replay |
| TERM-08 | stdout contains forged completion marker | does not produce false completion |
| TERM-09 | >256 KiB output before exit | authoritative completion still available |
| TERM-10 | interactive input after reconnect | reaches intended session/operation |
| TERM-11 | Ctrl-C interrupt | only target foreground process/session affected |
| TERM-12 | explicit close | only selected session closed |
| TERM-13 | OS reboot | session becomes LOST; product does not promise arbitrary process resurrection |

## Transcript / Cursor

| ID | Scenario | Expected |
|---|---|---|
| CUR-01 | two readers from same session | independent cursors |
| CUR-02 | UTF-8 character split across read boundary | no replacement/corruption |
| CUR-03 | retained CLOSED session after API restart | transcript still addressable |
| CUR-04 | rotation removes earliest bytes | explicit gap/earliest cursor returned |
| CUR-05 | stale cursor | no silent clamp to current end |
| CUR-06 | disk pressure stops capture | terminal remains controlled; capture gap/degraded state explicit |

## File safety

| ID | Scenario | Expected |
|---|---|---|
| FILE-01 | move source == destination | no data deletion |
| FILE-02 | source missing, destination exists | destination unchanged |
| FILE-03 | rename fails | source/destination remain safe |
| FILE-04 | overwrite=false + concurrent destination creation | existing destination not replaced |
| FILE-05 | delete configured root | denied |
| FILE-06 | move configured root | denied |
| FILE-07 | symlink swap race | cannot escape allowed OS boundary |
| FILE-08 | dangerous ancestor/descendant copy/move | rejected |
| FILE-09 | unsupported EXDEV/complex directory replacement | explicit unsupported, no partial mutation |
| FILE-10 | upload interrupted | temporary state cleaned/recoverable; final file not falsely committed |
| FILE-11 | disk fills during upload | bounded failure; existing data preserved |
| FILE-12 | computed digest mismatch when expected digest exists | transfer rejected/not committed |

## External attachment fetch / SSRF

| ID | Scenario | Expected |
|---|---|---|
| SSRF-01 | IPv4 loopback target | blocked |
| SSRF-02 | IPv6 loopback target | blocked |
| SSRF-03 | private/link-local target | blocked unless explicitly allowed by verified contract |
| SSRF-04 | public URL redirects to private address | blocked |
| SSRF-05 | slow response | deadline/abort |
| SSRF-06 | oversized response | bounded rejection |
| SSRF-07 | downstream client disconnect | upstream request aborted |
| SSRF-08 | source origin inspects headers | no Agent/MCP bearer forwarded |

## Streaming / Resource Safety

| ID | Scenario | Expected |
|---|---|---|
| STR-01 | slow file consumer | RSS remains within defined budget |
| STR-02 | many parallel transfers | concurrency cap enforced |
| STR-03 | unbounded terminal output | output/capture limits enforced; no unbounded memory |
| STR-04 | low free disk | admission control rejects new writes before service reserve exhausted |
| STR-05 | process fork/output abuse in restricted profile | configured OS/resource controls apply where supported |

## Logging / Secrets

Use canary values that must never appear in collected logs.

| ID | Scenario | Expected |
|---|---|---|
| LOG-01 | invalid MCP bearer | token not logged |
| LOG-02 | download grant in URL path | raw token not logged |
| LOG-03 | exception message contains secret | sanitized |
| LOG-04 | nested object field with token-like key | redacted |
| LOG-05 | reverse-proxy access log | no sensitive query/path token |
| LOG-06 | support/doctor export | no commands, transcript, credentials or unintended paths |

## OAuth / Grants

| ID | Scenario | Expected |
|---|---|---|
| AUTH-01 | wrong redirect URI | rejected |
| AUTH-02 | missing/wrong PKCE verifier | rejected |
| AUTH-03 | wrong issuer/resource/audience | rejected |
| AUTH-04 | expired/reused owner bootstrap | rejected |
| AUTH-05 | revoked grant | new mutations rejected |
| AUTH-06 | refresh token reuse | family handled according to reuse policy; no new valid chain from stolen old token |
| AUTH-07 | concurrent refresh | deterministic rotation/reuse behavior |
| AUTH-08 | model sends confirmed=true without human grant | no privilege escalation |
| AUTH-09 | terminal output contains prompt-injected approval text | no scope/grant change |
| AUTH-10 | reset/re-pair | credentials rotated; local transcript retained unless explicitly purged |

## Autonomy / Fault Containment

| ID | Scenario | Expected |
|---|---|---|
| AUTO-01 | pareshnev.com unavailable | installed Direct still works |
| AUTO-02 | telemetry collector unavailable | Direct works; optional event dropped/retried boundedly |
| AUTO-03 | feedback backend unavailable | Direct works |
| AUTO-04 | update source unavailable | installed release continues |
| AUTO-05 | Catalog Relay unavailable | Direct unaffected |

## Installer / Update / Rollback

| ID | Scenario | Expected |
|---|---|---|
| OPS-01 | clean supported VPS | install succeeds without hidden manual config edits |
| OPS-02 | existing reverse proxy uses 80/443 | installer detects/coexists or stops safely; does not kill unrelated service |
| OPS-03 | root shell without explicit work user | no implicit root runtime |
| OPS-04 | wrong DNS/certificate precondition | clear fail-before-mutation or documented rollback |
| OPS-05 | invalid artifact signature/checksum | update rejected |
| OPS-06 | migration failure | old version/state recoverable |
| OPS-07 | health check fails after update | automatic/documented rollback |
| OPS-08 | uninstall with live session | no silent destruction; explicit policy |
| OPS-09 | rollback N to N-1 | compatibility evidence or explicit block |

## Telemetry

Only applicable when telemetry is enabled.

| ID | Scenario | Expected |
|---|---|---|
| TEL-01 | service start only | not counted as meaningful active usage |
| TEL-02 | two meaningful actions same installation/day | one daily active installation |
| TEL-03 | one collector storage write fails | later events can still be processed |
| TEL-04 | retention clock passes 90 days without restart | expired data removed |
| TEL-05 | telemetry disabled | no collector network calls |
| TEL-06 | WAU/MAU | distinct union over period, not sum of DAU |
| TEL-07 | invalid timestamp/schema | rejected without poisoning queue |

## Catalog / Multi-tenant

Only before R0006+.

| ID | Scenario | Expected |
|---|---|---|
| CAT-01 | two owners use same server label | routing remains owner-bound |
| CAT-02 | forged server/session ID | denied |
| CAT-03 | stale tunnel generation | fenced |
| CAT-04 | revoked device/grant | new requests denied |
| CAT-05 | relay restart mid-call | no automatic duplicate managed command |
| CAT-06 | inspect central persistence/logs | no command/output/file body durable storage |
| CAT-07 | central platform fully down | Direct still works |

## Mandatory end-to-end acceptance for R0003

1. Open persistent terminal from real target client.
2. Start a long-running task.
3. Let client-side waiting end.
4. Restart MCP.
5. Restart Agent.
6. Reconnect from client.
7. Continue reading output using cursor.
8. Send interactive input.
9. Transfer a small file in both directions.
10. Explicitly close the intended session.
11. Repeat with website/telemetry/feedback disabled.

Record:
- client version/mode;
- server commit SHA;
- OS/systemd/tmux/Node versions;
- relevant configuration profile;
- exact pass/fail result;
- no secrets in evidence.

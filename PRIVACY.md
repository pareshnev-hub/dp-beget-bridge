# DP Beget Bridge privacy notice

Last updated: 2026-09-21.

## Direct mode

DP Beget Bridge runs on the user's server. Terminal commands, output, paths,
filenames, and file contents travel between the user's OpenAI client and that
server. They are not routed through or stored by `pareshnev.com`.

## Optional product telemetry

Telemetry is disabled by default in source builds and can be enabled or
disabled independently of the product. The exact allowlist is published in
`docs/TELEMETRY.md`. It includes an anonymous installation identifier, version,
platform family, active-day events, bucketed terminal duration, and bucketed
file-transfer size. It excludes command and file data.

The collector immediately converts installation identifiers to keyed hashes,
stores daily aggregates, does not intentionally persist source IP addresses,
and removes daily aggregate files after 90 days by default.

## Website and feedback

The product website may count downloads using aggregate web statistics.
Feedback text and optional name, email, and country are collected only when a
visitor submits the form. The form must disclose its retention period before
it is enabled.

## Control

Set `DP_TELEMETRY_ENABLED=false` and restart the agent to stop product
telemetry. Removing the local `/var/lib/dp-beget-bridge/installation-id` file
resets the anonymous identifier, but is not required to use the product.

Privacy questions and deletion requests are handled through the feedback form
at `https://pareshnev.com/dp-beget-bridge` once the public service is enabled.

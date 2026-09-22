# OAuth credential lifecycle

DP-014 adds durable refresh rotation, reuse detection, revocation and transcript-preserving owner reset for Direct Mode.

## Policy

- Access tokens are short-lived and bound to one owner, client, resource, grant and refresh-token family.
- Every refresh token is one-use. Reuse compromises the complete family; no grace window creates a second valid branch.
- Revocation blocks new MCP requests. It does not terminate a command that Session Host already started.
- Reset revokes grants and token families, disables OAuth clients and requires owner bootstrap/re-pair.
- Reset never deletes tmux sessions, operation state or transcript files. Close and purge remain separate explicit actions.
- Only refresh-token digests are stored. Tokens and proofs do not appear in status output, logs or telemetry.

## Local owner commands

Run the commands locally as an identity that can read and write the private auth directory. A systemd installation can load the existing OAuth environment file without printing it.

Status is read-only:

```bash
systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/dp-beget-bridge/mcp-oauth-spike.env /usr/bin/node /opt/dp-beget-bridge/scripts/auth-admin.mjs status
```

Revoke all current owner grants and refresh families:

```bash
systemd-run --quiet --wait --pipe --collect -p Environment=DP_AUTH_ADMIN_CONFIRM=REVOKE -p EnvironmentFile=/etc/dp-beget-bridge/mcp-oauth-spike.env /usr/bin/node /opt/dp-beget-bridge/scripts/auth-admin.mjs revoke-all
```

Reset and require re-pair:

```bash
systemd-run --quiet --wait --pipe --collect -p Environment=DP_AUTH_ADMIN_CONFIRM=RESET -p EnvironmentFile=/etc/dp-beget-bridge/mcp-oauth-spike.env /usr/bin/node /opt/dp-beget-bridge/scripts/auth-admin.mjs reset
```

After reset, consume the pending bootstrap locally and restart OAuth before pairing again:

```bash
systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/dp-beget-bridge/mcp-oauth-spike.env /usr/bin/node /opt/dp-beget-bridge/scripts/auth-bootstrap.mjs
systemctl restart dp-beget-mcp-oauth-spike.service
```

A rollback to code that cannot interpret the auth schema must stop and require re-pair. It must never reconstruct or reactivate revoked credentials.

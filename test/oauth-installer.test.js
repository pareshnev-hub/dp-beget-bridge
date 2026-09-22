import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("DP-012 staging installer keeps OAuth isolated from the tunnel listener", async () => {
  const installer = await fs.readFile("deploy/install-oauth-spike.sh", "utf8");
  const unit = await fs.readFile("deploy/systemd/dp-beget-mcp-oauth-spike.service", "utf8");

  assert.match(installer, /DP_MCP_HOST=127\.0\.0\.1/);
  assert.match(installer, /DP_MCP_AUTH_MODE=oauth/);
  assert.match(installer, /DP_ATTACHMENT_FETCH_ENABLED=false/);
  assert.match(installer, /DP_OAUTH_SCOPES=files:read/);
  assert.match(installer, /DP_OAUTH_ALLOWED_CLIENT_IDS=https:\/\/chatgpt\.com\/oauth\/client\.json/);
  assert.doesNotMatch(installer, /DP_MCP_ACCESS_TOKEN=.*\$\{mcp_token\}/);
  assert.match(installer, /read -r -s -p "OAuth staging approval secret/);
  assert.match(installer, /read -r -s -p "Confirm OAuth staging approval secret/);
  assert.doesNotMatch(installer, /empty generates one/);
  assert.doesNotMatch(installer, /openssl rand/);
  assert.match(unit, /EnvironmentFile=\/etc\/dp-beget-bridge\/mcp-oauth-spike\.env/);
  assert.match(unit, /^User=__DP_MCP_USER__$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const installer = fs.readFileSync(new URL("../deploy/install-tunnel-harness.sh", import.meta.url), "utf8");
const coreInstaller = fs.readFileSync(new URL("../deploy/install.sh", import.meta.url), "utf8");
const remover = fs.readFileSync(new URL("../deploy/remove-tunnel-harness.sh", import.meta.url), "utf8");
const release = fs.readFileSync(new URL("../deploy/tunnel/tunnel-client.release", import.meta.url), "utf8");
const config = fs.readFileSync(new URL("../deploy/tunnel/tunnel-client.yaml.template", import.meta.url), "utf8");
const unit = fs.readFileSync(new URL("../deploy/systemd/dp-beget-tunnel.service", import.meta.url), "utf8");

test("DP-017 pins the official linux-amd64 tunnel-client release and checksum", () => {
  assert.match(release, /^TUNNEL_CLIENT_VERSION=0\.0\.14$/m);
  assert.match(release, /^TUNNEL_CLIENT_GIT_SHA=0f870e50a973fa820d4c409000059e181e8d242b$/m);
  assert.match(release, /^TUNNEL_CLIENT_SHA256=15bd17e805cad39d412199115bb9e10a978dd35258a114cdf25dd2ae6681c7d3$/m);
  assert.match(installer, /sha256sum --check --status/);
  assert.match(installer, /version_output=.*--version/);
});

test("DP-017 preserves authenticated loopback MCP and keeps secrets out of argv", () => {
  assert.match(config, /url: http:\/\/127\.0\.0\.1:8788\/mcp/);
  assert.match(config, /Authorization: file:\/etc\/dp-beget-tunnel\/mcp-authorization/g);
  assert.match(config, /api_key: file:\/etc\/dp-beget-tunnel\/runtime-key/);
  assert.doesNotMatch(unit, /Environment=.*(?:API_KEY|AUTHORIZATION|BEARER|TOKEN)/i);
  assert.doesNotMatch(unit, /--(?:api-key|mcp\.extra-headers)/);
  assert.match(installer, /read -r -s -p/);
  assert.match(installer, /install -m 0640 -o root -g/);
  assert.match(installer, /install -d -m 0750 -o root -g "\$\{service_user\}" "\$\{config_dir\}"/);
  assert.match(installer, /mcp_env=\$\{bridge_config_dir\}\/mcp\.env/);
});

test("DP-017 tunnel service is dedicated, bounded, and loopback-only", () => {
  assert.match(unit, /^User=dp-tunnel$/m);
  assert.match(unit, /^Group=dp-tunnel$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^MemoryMax=256M$/m);
  assert.match(unit, /^MemorySwapMax=256M$/m);
  assert.match(unit, /^TasksMax=64$/m);
  assert.match(unit, /^LimitNOFILE=1024$/m);
  assert.match(config, /listen_addr: 127\.0\.0\.1:8790/);
  assert.doesNotMatch(config, /0\.0\.0\.0|\[::\]/);
});

test("DP-017 teardown is scoped and retains explicit Platform revocation", () => {
  assert.match(remover, /systemctl disable --now/);
  assert.match(remover, /^config_dir=\/etc\/dp-beget-tunnel$/m);
  assert.match(remover, /^install_root=\/opt\/dp-beget-tunnel$/m);
  assert.match(remover, /Revoke its runtime key and delete or disassociate the Platform tunnel separately/);
});

test("core updates preserve and revalidate an active tunnel harness", () => {
  assert.match(coreInstaller, /tunnel_was_active=false/);
  assert.match(coreInstaller, /systemctl stop "\$\{tunnel_unit\}"/);
  assert.match(coreInstaller, /systemctl start "\$\{tunnel_unit\}"/);
  assert.match(coreInstaller, /node scripts\/deploy\/wait-tunnel-ready\.mjs 15000/);
  assert.match(coreInstaller, /node scripts\/tunnel-doctor\.mjs/);
});

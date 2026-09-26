import test from "node:test";
import assert from "node:assert/strict";
import { validateBegetOAuthListenerSnapshot } from
  "../scripts/release/inspect-beget-oauth-listeners.mjs";

const listeners = [
  'LISTEN 0 511 127.0.0.1:8789 0.0.0.0:* users:(("node",pid=10,fd=24))',
  'LISTEN 0 4096 172.18.0.1:8791 0.0.0.0:* users:(("systemd",pid=1,fd=169))',
  'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=11,fd=7))',
  'LISTEN 0 4096 [::]:80 [::]:* users:(("docker-proxy",pid=12,fd=7))',
  'LISTEN 0 4096 0.0.0.0:443 0.0.0.0:* users:(("docker-proxy",pid=13,fd=7))',
  'LISTEN 0 4096 [::]:443 [::]:* users:(("docker-proxy",pid=14,fd=7))',
  'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=15,fd=7))'
];
function fixture() {
  const traefik = { Id: "a".repeat(64), Name: "/n8n-traefik-1", State: { Running: true },
    HostConfig: { NetworkMode: "n8n_default" }, NetworkSettings: { Ports: {
      "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "80" }, { HostIp: "::", HostPort: "80" }],
      "443/tcp": [{ HostIp: "0.0.0.0", HostPort: "443" }, { HostIp: "::", HostPort: "443" }]
    } } };
  const app = { Id: "b".repeat(64), Name: "/oauth-app", State: { Running: true },
    HostConfig: { NetworkMode: "n8n_default" }, NetworkSettings: { Ports: { "8789/tcp": null } } };
  return [traefik, app];
}

test("OPS-07: only Traefik publishes 80/443 and the OAuth listener is isolated", () => {
  const report = validateBegetOAuthListenerSnapshot(listeners.join("\n"), fixture());
  assert.deepEqual(report.publicPorts, [80, 443]);
  assert.equal(report.proxyAddress, "172.18.0.1:8791");
  const closed = listeners.filter(line => !line.includes(":8789") && !line.includes(":8791"));
  assert.equal(validateBegetOAuthListenerSnapshot(closed.join("\n"), fixture()).oauthAddress,
    "127.0.0.1:8789");
});

test("OPS-07: alternate listener or publisher fails before an ingress transition", () => {
  for (const newLine of [
    'LISTEN 0 128 0.0.0.0:8789 0.0.0.0:* users:(("node",pid=40,fd=7))',
    'LISTEN 0 128 [::]:8791 [::]:* users:(("systemd",pid=1,fd=7))',
    'LISTEN 0 128 127.0.0.1:443 0.0.0.0:* users:(("nginx",pid=2,fd=7))'
  ]) assert.throws(() => validateBegetOAuthListenerSnapshot([...listeners, newLine].join("\n"), fixture()),
    /listener inventory/);
  for (const mutate of [
    f => f[1].NetworkSettings.Ports["8789/tcp"] = [{ HostIp: "0.0.0.0", HostPort: "8789" }],
    f => f[1].NetworkSettings.Ports["443/tcp"] = [{ HostIp: "0.0.0.0", HostPort: "443" }],
    f => { f[0].NetworkSettings.Ports["443/tcp"] = null; },
    f => { f[1].HostConfig.NetworkMode = "host"; }
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => validateBegetOAuthListenerSnapshot(listeners.join("\n"), f),
      /listener inventory/);
  }
});

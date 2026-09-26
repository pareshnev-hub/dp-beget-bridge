import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateBegetTunnelConfig, validateBegetTunnelUnit } from
  "../scripts/release/inspect-beget-tunnel-target.mjs";

const TEMPLATE = new URL("../deploy/tunnel/tunnel-client.yaml.template", import.meta.url);
function unit(state = "active") {
  return `LoadState=loaded
ActiveState=${state}
MainPID=${state === "active" ? "12345" : "0"}
User=dp-tunnel
FragmentPath=/etc/systemd/system/dp-beget-tunnel.service
DropInPaths=
Environment=
ExecStart={ path=/opt/dp-beget-tunnel/current/tunnel-client ; argv[]=/opt/dp-beget-tunnel/current/tunnel-client run --config /etc/dp-beget-tunnel/tunnel-client.yaml ; ignore_errors=no ; start_time=[Sat 2026-09-26 18:33:27 UTC] ; stop_time=[n/a] ; pid=12345 ; code=(null) ; status=0/0 }
`;
}

test("the separate R0002 tunnel only targets the base MCP, across stopped and active unit views", async () => {
  const template = await readFile(TEMPLATE, "utf8");
  const actual = template.replace("__TUNNEL_ID__", "test-id-123");
  assert.equal(validateBegetTunnelConfig(actual, template), true);
  assert.deepEqual(validateBegetTunnelUnit(unit()), { state: "active", pid: "12345" });
  assert.deepEqual(validateBegetTunnelUnit(unit("inactive").replace(
    "code=(null) ; status=0/0", "code=exited ; status=0")),
  { state: "inactive", pid: "0" });
  for (const modified of [
    actual.replace("127.0.0.1:8788/mcp", "127.0.0.1:8789/mcp"),
    actual + "  extra: http://127.0.0.1:8789/mcp\n",
    actual.replace("Authorization: file:", "Authorization: Bearer ")
  ]) assert.throws(() => validateBegetTunnelConfig(modified, template), /alternate OAuth ingress/);
  for (const modified of [
    unit().replace("--config /etc/dp-beget-tunnel/tunnel-client.yaml",
      "--config /etc/dp-beget-tunnel/other.yaml"),
    unit() + "EnvironmentFiles=/etc/secret\n",
    unit().replace("MainPID=12345", "MainPID=0")
  ]) assert.throws(() => validateBegetTunnelUnit(modified), /alternate OAuth ingress/);
});

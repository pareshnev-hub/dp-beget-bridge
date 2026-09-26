import test from "node:test";
import assert from "node:assert/strict";
import { validateBegetOAuthProxySnapshot } from
  "../scripts/release/inspect-beget-oauth-proxy.mjs";

function fixture() {
  const socket = `Listen=172.18.0.1:8791 (Stream)
Triggers=dp-beget-oauth-proxy.service
LoadState=loaded
ActiveState=active
FragmentPath=/etc/systemd/system/dp-beget-oauth-proxy.socket
DropInPaths=
`;
  const service = `ExecStart={ path=/lib/systemd/systemd-socket-proxyd ; argv[]=/lib/systemd/systemd-socket-proxyd 127.0.0.1:8789 ; ignore_errors=no ; start_time=[Wed 2026-09-23 09:52:12 UTC] ; stop_time=[n/a] ; pid=653871 ; code=(null) ; status=0/0 }
User=dp-beget-oauth-proxy
LoadState=loaded
ActiveState=active
FragmentPath=/etc/systemd/system/dp-beget-oauth-proxy.service
DropInPaths=
`;
  return { socket, service };
}

test("OPS-07: loaded socket activates the exact proxyd target", () => {
  const { socket, service } = fixture();
  assert.deepEqual(validateBegetOAuthProxySnapshot(socket, service), {
    socketAddress: "172.18.0.1:8791", destination: "127.0.0.1:8789",
    socketState: "active", serviceState: "active", guardInstalled: false
  });
  const guardedSocket = socket.replace("DropInPaths=\n",
    "DropInPaths=/etc/systemd/system/dp-beget-oauth-proxy.socket.d/90-dp-r0004-migration-guard.conf\n")
    .replace("ActiveState=active", "ActiveState=inactive");
  const guardedService = service.replace("DropInPaths=\n",
    "DropInPaths=/etc/systemd/system/dp-beget-oauth-proxy.service.d/90-dp-r0004-migration-guard.conf\n")
    .replace("ActiveState=active", "ActiveState=inactive")
    .replace("stop_time=[n/a]", "stop_time=[Sat 2026-09-26 18:33:27 UTC]")
    .replace("code=(null) ; status=0/0", "code=exited ; status=0");
  assert.equal(validateBegetOAuthProxySnapshot(guardedSocket, guardedService).guardInstalled, true);
});

test("OPS-07: stopped proxyd keeps its pinned destination with systemd exit metadata", () => {
  const { socket, service } = fixture();
  const stopped = service.replace("ActiveState=active", "ActiveState=inactive")
    .replace("stop_time=[n/a]", "stop_time=[Sat 2026-09-26 18:33:27 UTC]")
    .replace("code=(null) ; status=0/0", "code=exited ; status=0");
  assert.deepEqual(validateBegetOAuthProxySnapshot(
    socket.replace("ActiveState=active", "ActiveState=inactive"), stopped), {
    socketAddress: "172.18.0.1:8791", destination: "127.0.0.1:8789",
    socketState: "inactive", serviceState: "inactive", guardInstalled: false
  });
});

test("OPS-07: changed proxy route, executable or loaded guard fails closed", () => {
  for (const change of [
    f => { f.socket = f.socket.replace(":8791", ":8792"); },
    f => { f.socket = f.socket.replace("Triggers=dp-beget-oauth-proxy.service", "Triggers=other.service"); },
    f => { f.service = f.service.replace("127.0.0.1:8789", "127.0.0.1:8790"); },
    f => { f.service = f.service.replace("/lib/systemd/systemd-socket-proxyd", "/tmp/other"); },
    f => { f.service = f.service.replace("User=dp-beget-oauth-proxy", "User=root"); },
    f => { f.service = f.service.replace("code=(null)", "code=forged"); },
    f => { f.service = f.service.replace("status=0/0", "status=42"); },
    f => { f.socket = f.socket.replace("DropInPaths=\n", "DropInPaths=/run/other.conf\n"); },
    f => { f.service = f.service.replace("ActiveState=active", "ActiveState=failed"); }
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => validateBegetOAuthProxySnapshot(f.socket, f.service),
      /proxy topology/);
  }
});

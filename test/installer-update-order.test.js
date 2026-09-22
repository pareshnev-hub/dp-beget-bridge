import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

test("installer activates new Session Host code only after a fail-closed ledger preflight", async () => {
  const installer = await fs.readFile("deploy/install.sh", "utf8");
  const orderedSteps = [
    "systemctl stop \"${mcp_unit}\" \"${agent_unit}\"",
    "session-host-restart-preflight.mjs",
    "systemctl stop \"${session_host_unit}\"",
    "install_code_tree \"${source_dir}\" /opt/dp-beget-bridge",
    "systemctl start \"${session_host_unit}\"",
    "wait-session-host.mjs",
    "systemctl restart \"${agent_unit}\" \"${mcp_unit}\"",
  ];

  let previousOffset = -1;
  for (const step of orderedSteps) {
    const offset = installer.indexOf(step, previousOffset + 1);
    assert.ok(offset > previousOffset, `installer step is missing or out of order: ${step}`);
    previousOffset = offset;
  }
  assert.match(installer, /Installation failed; restoring local services/);
  assert.match(installer, /systemctl stop "\$\{oauth_unit\}"/);
  assert.match(installer, /systemctl start "\$\{oauth_unit\}"/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { inspectCreatedCleanIdentities } from "../scripts/release/inspect-clean-install-created-identities.mjs";
import { createGroup, createUser } from "../scripts/release/install-clean-identities.mjs";

const exec = promisify(execFile);

// Run only on a disposable root CI host. The production account commands and
// NSS lookup must agree, including when a group exists but its user does not.
test("OPS-01: real shadow-utils identities bind to the transaction", {
  skip: process.env.DP_TEST_REAL_ACCOUNTS !== "1" || process.getuid?.() !== 0
}, async t => {
  const suffix = randomBytes(5).toString("hex");
  const plan = { ipcGroup: `dpb_i_${suffix}`, agentUser: `dpb_a_${suffix}`,
    mcpUser: `dpb_m_${suffix}` };
  const transactionId = randomUUID();
  const groups = [plan.ipcGroup, plan.agentUser, plan.mcpUser];
  const users = [plan.agentUser, plan.mcpUser];
  t.after(async () => {
    for (const name of users.toReversed()) {
      await exec("userdel", ["--", name]).catch(error => {
        if (error.code !== 6) throw error;
      });
    }
    for (const name of groups.toReversed()) {
      await exec("groupdel", ["--", name]).catch(error => {
        if (error.code !== 6) throw error;
      });
    }
  });

  for (const name of groups) await createGroup(name);
  await assert.rejects(inspectCreatedCleanIdentities({ plan, transactionId }),
    /getent|Command failed/);
  await createUser(plan.agentUser, transactionId, "/var/lib/dp-beget-bridge-agent");
  await createUser(plan.mcpUser, transactionId, "/var/lib/dp-beget-bridge-mcp");
  const result = await inspectCreatedCleanIdentities({ plan, transactionId });
  assert.equal(result.identities, "journal-bound");
  assert.notEqual(result.agentUid, result.mcpUid);
  await assert.rejects(inspectCreatedCleanIdentities({ plan,
    transactionId: randomUUID() }), /does not match its journaled identity/);
  await assert.rejects(createGroup(plan.ipcGroup), /already exists|Command failed/);
});

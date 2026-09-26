import test from "node:test";
import assert from "node:assert/strict";
import { inspectCreatedCleanIdentities } from "../scripts/release/inspect-clean-install-created-identities.mjs";

const transactionId = "c3bd7d40-35e9-48bf-94bd-a1e058e0eb3b";
const plan = { agentUser: "dp-agent", mcpUser: "dp-mcp", ipcGroup: "dp-ipc" };
const records = {
  "group:dp-ipc": "dp-ipc:x:990:",
  "group:dp-agent": "dp-agent:x:991:",
  "group:dp-mcp": "dp-mcp:x:992:",
  "passwd:dp-agent": `dp-agent:x:990:991:DP Beget clean install ${transactionId}:/var/lib/dp-beget-bridge-agent:/usr/sbin/nologin`,
  "passwd:dp-mcp": `dp-mcp:x:991:992:DP Beget clean install ${transactionId}:/var/lib/dp-beget-bridge-mcp:/usr/sbin/nologin`,
};

test("OPS-01: installed identities require exact journal marker, isolated groups and separate UIDs", async () => {
  const lookup = async (kind, name) => records[`${kind}:${name}`];
  assert.equal((await inspectCreatedCleanIdentities({ plan, transactionId, lookup })).identities,
    "journal-bound");
  await assert.rejects(inspectCreatedCleanIdentities({ plan, transactionId,
    lookup: async (kind, name) => kind === "group" && name === "dp-ipc"
      ? "dp-ipc:x:990:unrelated-user" : lookup(kind, name) }), /not isolated/);
  await assert.rejects(inspectCreatedCleanIdentities({ plan, transactionId,
    lookup: async (kind, name) => kind === "passwd" && name === "dp-agent"
      ? records["passwd:dp-agent"].replace(transactionId, "unrelated") : lookup(kind, name) }),
  /does not match/);
  await assert.rejects(inspectCreatedCleanIdentities({ plan, transactionId,
    lookup: async (kind, name) => kind === "passwd" && name === "dp-mcp"
      ? records["passwd:dp-mcp"].replace(":991:992:", ":990:992:") : lookup(kind, name) }),
  /distinct numeric IDs/);
});

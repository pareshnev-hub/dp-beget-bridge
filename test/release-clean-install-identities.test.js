import test from "node:test";
import assert from "node:assert/strict";
import { inspectCleanInstallIdentities } from "../scripts/release/preflight-clean-install-identities.mjs";

const base = { workUser: "operator", workGroup: "operator", agentUser: "dp-agent",
  mcpUser: "dp-mcp", ipcGroup: "dp-ipc", allowedRoot: "/srv/operator",
  inspectWork: async (_, field) => field === "-u" ? "1001" : "operator",
  hasIdentity: async (kind, value) => kind === "group" && value === "operator",
  inspectPath: async () => ({ isDirectory: () => true, uid: 1001, mode: 0o40750 }),
  resolvePath: async value => value };

test("OPS-01: work directory ownership and reserved service names are checked before install", async () => {
  assert.equal((await inspectCleanInstallIdentities(base)).reservedIdentities, "unoccupied");
  await assert.rejects(inspectCleanInstallIdentities({ ...base,
    hasIdentity: async (kind, value) => kind === "group" && value === "operator" ||
      kind === "passwd" && value === "dp-agent" }), /already exists/);
  await assert.rejects(inspectCleanInstallIdentities({ ...base,
    hasIdentity: async (kind, value) => kind === "group" && ["operator", "dp-ipc"].includes(value) }),
  /IPC group already exists/);
  await assert.rejects(inspectCleanInstallIdentities({ ...base,
    inspectPath: async () => ({ isDirectory: () => true, uid: 0, mode: 0o40750 }) }),
  /private and owned/);
  await assert.rejects(inspectCleanInstallIdentities({ ...base,
    inspectPath: async () => ({ isDirectory: () => true, uid: 1001, mode: 0o40755 }) }),
  /private and owned/);
  await assert.rejects(inspectCleanInstallIdentities({ ...base, mcpUser: "operator" }), /distinct/);
  await assert.rejects(inspectCleanInstallIdentities({ ...base,
    inspectWork: async (_, field) => field === "-u" ? "0" : "operator" }), /work identity/);
});

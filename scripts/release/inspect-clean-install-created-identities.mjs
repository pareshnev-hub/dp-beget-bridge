import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function getent(kind, name) {
  const { stdout } = await exec("getent", [kind, name], { timeout: 5000, maxBuffer: 4096 });
  return stdout.trim();
}

function groupRecord(value, name) {
  const fields = value.split(":");
  const gid = Number(fields[2]);
  if (fields.length !== 4 || fields[0] !== name || !Number.isSafeInteger(gid) || gid < 1 ||
      fields[3] !== "") throw new Error("Created service group is not isolated");
  return gid;
}

function userRecord(value, name, gid, transactionId, home) {
  const fields = value.split(":");
  const uid = Number(fields[2]);
  if (fields.length !== 7 || fields[0] !== name || !Number.isSafeInteger(uid) || uid < 1 ||
      Number(fields[3]) !== gid || fields[4] !== `DP Beget clean install ${transactionId}` ||
      fields[5] !== home || fields[6] !== "/usr/sbin/nologin") {
    throw new Error("Created service account does not match its journaled identity");
  }
  return uid;
}

export async function inspectCreatedCleanIdentities({ plan, transactionId,
  lookup = getent } = {}) {
  if (!plan || !/^[0-9a-f-]{36}$/.test(transactionId || "")) {
    throw new Error("A journal-bound clean-install identity plan is required");
  }
  const ipcGid = groupRecord(await lookup("group", plan.ipcGroup), plan.ipcGroup);
  const agentGid = groupRecord(await lookup("group", plan.agentUser), plan.agentUser);
  const mcpGid = groupRecord(await lookup("group", plan.mcpUser), plan.mcpUser);
  if (new Set([ipcGid, agentGid, mcpGid]).size !== 3) {
    throw new Error("Created service groups must have distinct numeric IDs");
  }
  const agentUid = userRecord(await lookup("passwd", plan.agentUser), plan.agentUser,
    agentGid, transactionId, "/var/lib/dp-beget-bridge-agent");
  const mcpUid = userRecord(await lookup("passwd", plan.mcpUser), plan.mcpUser,
    mcpGid, transactionId, "/var/lib/dp-beget-bridge-mcp");
  if (agentUid === mcpUid) throw new Error("Created service accounts must have distinct numeric IDs");
  return { identities: "journal-bound", agentUid, mcpUid, ipcGid, agentGid, mcpGid };
}

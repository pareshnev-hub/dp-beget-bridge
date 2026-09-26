import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectBegetLegacyDataBindings } from "../scripts/release/inspect-beget-legacy-data-bindings.mjs";

test("OPS-06: root process inventory binds three service databases without disclosing environment", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-data-bindings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expected = [
    { unit: "session", key: "DP_SESSION_DATA_DIR", directory: path.join(root, "session"), filename: "state.sqlite" },
    { unit: "agent", key: "DP_DATA_DIR", directory: path.join(root, "agent"), filename: "session-owners.sqlite" },
    { unit: "oauth", key: "DP_AUTH_DATA_DIR", directory: path.join(root, "oauth"), filename: "auth.sqlite", mode: "oauth" }
  ];
  for (const item of expected) {
    await mkdir(item.directory);
    await writeFile(path.join(item.directory, item.filename), Buffer.alloc(64));
  }
  await writeFile(path.join(expected[0].directory, "state.sqlite.backup-v1"), Buffer.alloc(32));
  await writeFile(path.join(expected[0].directory, "state.sqlite.backup-v0"), Buffer.alloc(16));
  const itemFor = pid => expected[Number(pid) - 1];
  const oauthSource = Buffer.from("authDataDir: /var/lib/dp-beget-bridge-mcp/auth");
  const options = { expected, requireRoot: () => true, show: async unit => String(expected.findIndex(e => e.unit === unit) + 1),
    oauthCodeRoot: root, processCwd: async () => root,
    readOAuthConfig: async () => oauthSource,
    oauthConfigSha256: createHash("sha256").update(oauthSource).digest("hex"),
    readEnvironment: async pid => {
      const item = itemFor(pid);
      return Buffer.from(`${item.mode ? "" : `${item.key}=${item.directory}\0`}DP_MCP_AUTH_MODE=${item.mode || "static"}\0` +
        "DP_OAUTH_STAGING_APPROVAL_SECRET=do-not-output-this-secret\0");
    } };
  const result = await inspectBegetLegacyDataBindings(options);
  assert.equal(result.databases.length, 3);
  assert.equal(result.databases.reduce((sum, item) => sum + item.size, 0), 192);
  assert.doesNotMatch(JSON.stringify(result), /do-not-output-this-secret/);
  await writeFile(path.join(expected[2].directory, "unknown.sqlite"), "untracked");
  await assert.rejects(inspectBegetLegacyDataBindings(options), /oauth, sqlite-inventory/);
  await rm(path.join(expected[2].directory, "unknown.sqlite"));
  await assert.rejects(inspectBegetLegacyDataBindings({ ...options,
    readEnvironment: async () => Buffer.from("DP_DATA_DIR=/tmp/wrong\0SECRET=do-not-output-this-secret\0") }),
  error => !error.message.includes("do-not-output-this-secret") && /session, data-directory/.test(error.message));
  await assert.rejects(inspectBegetLegacyDataBindings({ ...options,
    readEnvironment: async () => { throw new Error("do-not-output-this-secret"); } }),
  error => !error.message.includes("do-not-output-this-secret") && /session, environment-inspection/.test(error.message));
});

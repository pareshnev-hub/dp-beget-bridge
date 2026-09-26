import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stageLegacyCounterHotfix } from "../scripts/release/stage-legacy-counter-hotfix.mjs";
import { preflightLegacyCounterHotfix } from "../scripts/release/preflight-legacy-counter-hotfix.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-r0003-hotfix-ready-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const live = path.join(root, "live");
  const candidate = path.join(root, "candidate");
  await mkdir(live);
  await mkdir(candidate);
  const files = [];
  for (const name of ["agent", "base-mcp", "session-host", "oauth-mcp"]) {
    const relative = `apps/${name}/src/server.js`;
    const original = Buffer.from(`original-${name}\n`);
    const updated = Buffer.from(`updated-${name}\n`);
    for (const [directory, bytes] of [[live, original], [candidate, updated]]) {
      const filename = path.join(directory, relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, bytes);
      await chmod(filename, directory === live ? 0o664 : 0o644);
    }
    files.push({ name, root: live, relative, before: digest(original), after: digest(updated) });
  }
  const stageDir = path.join(root, "stage");
  const { manifestSha256 } = await stageLegacyCounterHotfix({
    outputDir: stageDir, candidateRoot: candidate, files });
  const options = { stageDir, manifestSha256, files,
    inspectServices: async () => Object.fromEntries([
      "dp-beget-session-host.service", "dp-beget-agent.service", "dp-beget-mcp.service",
      "dp-beget-mcp-oauth-spike.service", "dp-beget-oauth-proxy.socket",
      "dp-beget-tunnel.service"].map(unit => [unit, "active"])),
    inspectBindings: async () => ({ databases: [
      { unit: "dp-beget-session-host.service", database: "/tmp/ledger" }, {}, {}] }),
    readHealth: async () => ({ services: 4, products: ["a", "b", "c", "d"] }),
    assertRestartSafe: () => ({ activeOperationCount: 0 }), ledgerPath: "/tmp/ledger" };
  return { options, files, live };
}

test("one read-only preflight binds stage, live code, units, data and terminal operations", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { options } = await fixture(t);
  const result = await preflightLegacyCounterHotfix(options);
  assert.equal(result.files, 4);
  assert.equal(result.activeOperations, 0);
  await assert.rejects(preflightLegacyCounterHotfix({ ...options,
    assertRestartSafe: () => ({ activeOperationCount: 1 }) }), /operations remain active/);
});

test("modified stage or live source prevents preflight", {
  skip: process.getuid?.() !== 0
}, async t => {
  const { options, files, live } = await fixture(t);
  const staged = path.join(options.stageDir, "oauth-mcp.after.js");
  await writeFile(staged, "unreviewed code");
  await assert.rejects(preflightLegacyCounterHotfix(options), /digest changed/);
  await writeFile(staged, Buffer.from(`updated-oauth-mcp\n`));
  await writeFile(path.join(live, files[0].relative), "unreviewed live code");
  await assert.rejects(preflightLegacyCounterHotfix(options), /digest changed/);
  assert.equal(digest(await readFile(path.join(options.stageDir, "manifest.json"))),
    options.manifestSha256);
});

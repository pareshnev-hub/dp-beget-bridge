import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "../apps/agent/src/state-store.js";
import { archiveTerminal, verifyTerminalArchive } from "../scripts/archive-terminal.mjs";
import { segmentPath } from "../scripts/transcript-segments.mjs";

async function fixture(t, closed = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dpb-archive-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const store = new StateStore(dataDir);
  await store.init();
  t.after(() => store.close());
  await store.save({ id: "terminal-1", label: "Canary command", cwd: "/sensitive/path",
    createdAt: new Date().toISOString(), closedAt: null });
  if (closed) await store.closeSession("terminal-1");
  return { root, dataDir, store, outputDir: path.join(root, "archive") };
}

test("R0004: a CLOSED segmented transcript archives, verifies, and stays readable", async t => {
  const { store, dataDir, outputDir } = await fixture(t);
  const source = store.outputPath("terminal-1");
  await fs.writeFile(source, "A🙂");
  await fs.writeFile(segmentPath(source, 1), "B");
  const result = await archiveTerminal({ dataDir, sessionId: "terminal-1", outputDir });
  assert.deepEqual(result, { sessionId: "terminal-1", size: 6, files: 2 });
  assert.deepEqual(await verifyTerminalArchive(outputDir), result);
  assert.equal((await fs.stat(outputDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(outputDir, "terminal.log"))).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(source, "utf8"), "A🙂");
  assert.ok(await store.get("terminal-1"));
  const manifest = await fs.readFile(path.join(outputDir, "archive.json"), "utf8");
  assert.doesNotMatch(manifest, /Canary command|sensitive\/path/);
  await fs.writeFile(segmentPath(path.join(outputDir, "terminal.log"), 1), "tampered");
  await assert.rejects(verifyTerminalArchive(outputDir), /changed|checksum/);
});

test("R0004: archival refuses OPEN sessions and leaves no output directory", async t => {
  const { store, dataDir, outputDir } = await fixture(t, false);
  await fs.writeFile(store.outputPath("terminal-1"), "unfinished");
  await assert.rejects(archiveTerminal({ dataDir, sessionId: "terminal-1", outputDir }), /CLOSED/);
  await assert.rejects(fs.access(outputDir), { code: "ENOENT" });
});

test("R0004: archive streams large legacy output and rejects an untrusted segment", async t => {
  const { store, dataDir, root, outputDir } = await fixture(t);
  const original = Buffer.alloc(130001, 0x61);
  const source = store.outputPath("terminal-1");
  await fs.writeFile(source, original);
  const report = await archiveTerminal({ dataDir, sessionId: "terminal-1", outputDir });
  assert.equal(report.size, original.length);
  assert.deepEqual(await fs.readFile(path.join(outputDir, "terminal.log")), original);
  const untrusted = path.join(root, "untrusted");
  await fs.writeFile(untrusted, "secret");
  await fs.symlink(untrusted, segmentPath(source, 1));
  const second = path.join(root, "second-archive");
  await assert.rejects(archiveTerminal({ dataDir, sessionId: "terminal-1", outputDir: second }));
  await assert.rejects(fs.access(second), { code: "ENOENT" });
  await store.purge("terminal-1");
  assert.equal(await store.get("terminal-1"), null);
  assert.deepEqual(await verifyTerminalArchive(outputDir), report);
});

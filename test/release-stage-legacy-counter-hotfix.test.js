import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stageLegacyCounterHotfix } from "../scripts/release/stage-legacy-counter-hotfix.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-r0003-hotfix-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidateRoot = path.join(root, "candidate");
  const sourceRoot = path.join(root, "live");
  await mkdir(candidateRoot, { mode: 0o700 });
  await mkdir(sourceRoot, { mode: 0o700 });
  const files = [];
  for (const name of ["agent", "base-mcp", "session-host", "oauth-mcp"]) {
    const relative = `apps/${name}/src/server.js`;
    const before = Buffer.from(`original-${name}\n`);
    const after = Buffer.from(`hotfix-${name}\n`);
    for (const [directory, bytes] of [[sourceRoot, before], [candidateRoot, after]]) {
      const file = path.join(directory, relative);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes, { mode: directory === sourceRoot ? 0o664 : 0o644 });
      if (directory === sourceRoot) await chmod(file, 0o664);
    }
    files.push({ root: sourceRoot, relative, name, before: digest(before), after: digest(after) });
  }
  return { root, sourceRoot, candidateRoot, files,
    outputDir: path.join(root, "staged-hotfix") };
}

test("staging preserves exact original and hotfix bytes without changing live files", {
  skip: process.getuid?.() !== 0
}, async t => {
  const args = await fixture(t);
  // A root checkout with umask 0002 may use 0775 and 0664. Hashes still
  // bind every copied byte, while the new staging directory stays 0700.
  await chmod(args.candidateRoot, 0o775);
  await chmod(path.join(args.candidateRoot, args.files[0].relative), 0o664);
  const result = await stageLegacyCounterHotfix(args);
  assert.equal(result.files, 4);
  const manifest = JSON.parse(await readFile(path.join(args.outputDir, "manifest.json")));
  assert.equal(manifest.files.length, 4);
  for (const item of args.files) {
    assert.equal(digest(await readFile(path.join(args.outputDir, `${item.name}.before.js`))), item.before);
    assert.equal(digest(await readFile(path.join(args.outputDir, `${item.name}.after.js`))), item.after);
    assert.equal(digest(await readFile(path.join(args.sourceRoot, item.relative))), item.before);
  }
  await assert.rejects(stageLegacyCounterHotfix(args), { code: "EEXIST" });
});

test("changed live code or candidate bytes prevent creating any staging directory", {
  skip: process.getuid?.() !== 0
}, async t => {
  const args = await fixture(t);
  await writeFile(path.join(args.sourceRoot, args.files[1].relative), "unexpected\n");
  await assert.rejects(stageLegacyCounterHotfix(args), /pinned hotfix base/);
  await assert.rejects(stat(args.outputDir), { code: "ENOENT" });
  await writeFile(path.join(args.sourceRoot, args.files[1].relative), "original-base-mcp\n");
  await writeFile(path.join(args.candidateRoot, args.files[2].relative), "unexpected\n");
  await assert.rejects(stageLegacyCounterHotfix(args), /pinned hotfix base/);
  await assert.rejects(stat(args.outputDir), { code: "ENOENT" });
});

test("staging rejects wider live permissions even when the pinned bytes match", {
  skip: process.getuid?.() !== 0
}, async t => {
  const args = await fixture(t);
  const filename = path.join(args.sourceRoot, args.files[0].relative);
  await chmod(filename, 0o666);
  await assert.rejects(stageLegacyCounterHotfix(args), /Untrusted R0003 source file/);
  await assert.rejects(stat(args.outputDir), { code: "ENOENT" });
});

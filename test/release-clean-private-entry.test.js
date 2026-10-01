import test from "node:test";
import assert from "node:assert/strict";
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installCleanPrivate, parseCleanPrivateRequest, readCleanPrivateRequest,
  runCleanPrivateCli } from "../scripts/release/install-clean-private.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dp-private-entry-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const request = { format: "dp-beget-clean-private-request-v1", artifact: `${root}/release.tar.gz`,
    manifest: `${root}/manifest.json`, signature: `${root}/manifest.sig`, trustDir: `${root}/trust`,
    allowedRoot: "/srv/work", workspaceParent: root, workspace: `${root}/candidate`, releaseRoot: "/opt/dp-release",
    journalPath: `${root}/install.json`, domain: "bridge.example.com", expectedIp: "1.1.1.1",
    workUser: "worker", workGroup: "worker", agentUser: "dp-agent", mcpUser: "dp-mcp", ipcGroup: "dp-work",
    ownerId: "owner-ci", executionProfile: "files-read" };
  const prepared = { workspace: request.workspace, manifestSha256: "a".repeat(64), sha256: "b".repeat(64),
    commit: "c".repeat(40), version: "0.1.0" };
  const installed = { transactionId: "00000000-0000-4000-8000-000000000001", phase: "owner-ready",
    owner: "candidate-bound", authMode: "oauth", localServices: "inactive", admission: "paused",
    publicIngress: "unproven", commit: prepared.commit, version: prepared.version };
  const calls = [];
  const args = { requestPath: `${root}/request.json`, isRoot: () => true,
    readRequest: async () => ({ ...request }), prepare: async inputs => { calls.push({ prepare: inputs }); return prepared; },
    install: async inputs => { calls.push({ install: inputs }); return { ...installed, secret: "should-not-be-forwarded" }; } };
  return { root, request, prepared, installed, calls, args };
}

test("OPS-01: one private entry binds prepared candidate to fresh OAuth owner controller and returns no extra fields", async t => {
  const f = await fixture(t), result = await installCleanPrivate(f.args);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].prepare.authMode, "oauth");
  assert.equal(f.calls[0].prepare.ownerId, f.request.ownerId);
  assert.equal(f.calls[0].prepare.executionProfile, "files-read");
  assert.equal(f.calls[1].install.initializeOwner, true);
  assert.equal(f.calls[1].install.manifestSha256, f.prepared.manifestSha256);
  assert.equal(f.calls[1].install.journalPath, f.request.journalPath);
  assert.equal(result.phase, "owner-ready");
  assert.equal(result.publicIngress, "unproven");
  assert.equal(Object.keys(result).length, 8);
  assert.equal(JSON.stringify(result).includes("should-not-be-forwarded"), false);
});

test("OPS-01: requests reject unknown options, invalid identity/profile and overlapping paths before preparation", async t => {
  const f = await fixture(t);
  const encode = value => Buffer.from(JSON.stringify(value));
  assert.deepEqual(parseCleanPrivateRequest(encode(f.request)), f.request);
  for (const change of [{ token: "sensitive" }, { authMode: "static" }, { ownerId: "bad\nDP_OWNER_ID=other" },
    { executionProfile: "administrator" }, { workUser: "root" }, { domain: "BRIDGE.example.com" },
    { expectedIp: "127.0.0.1" }, { workspace: `${f.root}/.hidden` }, { workspace: `${f.root}/../candidate` },
    { journalPath: `${f.root}/candidate/journal.json` }, { releaseRoot: `${f.root}/versions` },
    { signature: f.request.manifest }, { artifact: "/tmp/line\nfeed" }]) {
    f.args.readRequest = async () => ({ ...f.request, ...change });
    await assert.rejects(installCleanPrivate(f.args));
    assert.deepEqual(f.calls, []);
    assert.throws(() => parseCleanPrivateRequest(encode({ ...f.request, ...change })));
  }
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(16385), Buffer.from("{"), Buffer.from("null"), Buffer.from("[]")]) {
    assert.throws(() => parseCleanPrivateRequest(bytes));
  }
});

test("OPS-01: an existing or linked journal refuses preparation and root is required", async t => {
  const f = await fixture(t);
  await assert.rejects(installCleanPrivate({ ...f.args, isRoot: () => false }), /Root/);
  await writeFile(f.request.journalPath, "retained recovery", { mode: 0o600 });
  await assert.rejects(installCleanPrivate(f.args), /fresh journal/);
  assert.equal(await readFile(f.request.journalPath, "utf8"), "retained recovery");
  await rm(f.request.journalPath);
  await symlink(`${f.root}/absent`, f.request.journalPath);
  await assert.rejects(installCleanPrivate(f.args), /fresh journal/);
  assert.deepEqual(f.calls, []);
});

test("OPS-01: preparation failure or incomplete candidate cannot reach live installation", async t => {
  for (const failure of ["failure", "workspace", "digest", "commit", "version"]) {
    const f = await fixture(t);
    f.args.prepare = async () => {
      f.calls.push("prepare");
      if (failure === "failure") throw new Error("failed signed preparation");
      return { ...f.prepared, ...(failure === "workspace" ? { workspace: `${f.root}/other` } :
        failure === "digest" ? { manifestSha256: "invalid" } : failure === "commit" ? { commit: "invalid" } : { version: "invalid" }) };
    };
    await assert.rejects(installCleanPrivate(f.args));
    assert.deepEqual(f.calls, ["prepare"]);
  }
});

test("OPS-01: installation interruption preserves journal and candidate without automatic cleanup or replay", async t => {
  const f = await fixture(t);
  f.args.install = async () => {
    await writeFile(f.request.journalPath, "owner-intent retained", { mode: 0o600 });
    await writeFile(`${f.root}/candidate-retained`, "private state", { mode: 0o600 });
    throw new Error("owner command interrupted");
  };
  await assert.rejects(installCleanPrivate(f.args), /interrupted/);
  assert.equal(await readFile(f.request.journalPath, "utf8"), "owner-intent retained");
  assert.equal(await readFile(`${f.root}/candidate-retained`, "utf8"), "private state");
  await assert.rejects(installCleanPrivate(f.args), /fresh journal/);
  assert.equal(f.calls.length, 1);
});

test("OPS-01: unexpected final identity, active services or missing owner cannot claim private completion", async t => {
  for (const change of [{ commit: "d".repeat(40) }, { version: "1.0.0" }, { phase: "startup-ready" },
    { owner: "unproven" }, { localServices: "active" }, { admission: "open" }, { publicIngress: "closed-exclusive" }]) {
    const f = await fixture(t);
    f.args.install = async () => ({ ...f.installed, ...change });
    await assert.rejects(installCleanPrivate(f.args), /Final clean private/);
  }
});

test("OPS-01: CLI reports bounded success and redacts secret-bearing failures", async () => {
  const output = [], errors = [];
  const common = { stdout: text => output.push(text), stderr: text => errors.push(text) };
  assert.equal(await runCleanPrivateCli(["--request", "/private/request.json"], { ...common,
    install: async inputs => { assert.equal(inputs.requestPath, "/private/request.json"); return { phase: "owner-ready" }; } }), 0);
  assert.deepEqual(output, ['{"phase":"owner-ready"}\n']);
  assert.equal(await runCleanPrivateCli(["--request", "/private/request.json"], { ...common,
    install: async () => { throw new Error("secret=should-not-be-forwarded\ncommand-output"); } }), 1);
  assert.equal(errors.join("").includes("should-not-be-forwarded"), false);
  assert.equal(await runCleanPrivateCli(["--request", "/private/request.json", "--start"], { ...common,
    install: () => assert.fail("invalid CLI attempted installation") }), 64);
});

test("OPS-01: real private request reader rejects links, permissive metadata and oversized input", async t => {
  if (process.platform !== "linux" || process.getuid?.() !== 0) { t.skip("requires root Linux metadata checks"); return; }
  const f = await fixture(t);
  await chmod(f.root, 0o700);
  await writeFile(f.args.requestPath, JSON.stringify(f.request), { mode: 0o600 });
  assert.deepEqual(await readCleanPrivateRequest(f.args.requestPath), f.request);
  await chmod(f.args.requestPath, 0o644);
  await assert.rejects(readCleanPrivateRequest(f.args.requestPath), /Untrusted/);
  await chmod(f.args.requestPath, 0o600);
  await link(f.args.requestPath, `${f.root}/hardlink`);
  await assert.rejects(readCleanPrivateRequest(f.args.requestPath), /Untrusted/);
  await rm(`${f.root}/hardlink`);
  await symlink(f.args.requestPath, `${f.root}/link`);
  await assert.rejects(readCleanPrivateRequest(`${f.root}/link`));
  await writeFile(f.args.requestPath, Buffer.alloc(16385));
  await assert.rejects(readCleanPrivateRequest(f.args.requestPath), /Untrusted/);
  await chmod(f.root, 0o755);
  await assert.rejects(readCleanPrivateRequest(f.args.requestPath), /Untrusted/);
});

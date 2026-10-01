import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectCleanClosedIngress } from "../scripts/release/inspect-clean-closed-ingress.mjs";
import { startCleanProtected } from "../scripts/release/start-clean-protected.mjs";

const exec = promisify(execFile);
function fixture() {
  const request = { format: "dp-beget-clean-private-request-v1", artifact: "/root/artifact.tar.gz",
    manifest: "/root/manifest.json", signature: "/root/manifest.sig", trustDir: "/root/trust",
    domain: "bridge.example.com", expectedIp: "1.1.1.1", workUser: "worker", workGroup: "worker",
    agentUser: "dp-agent", mcpUser: "dp-mcp", ipcGroup: "dp-ipc", allowedRoot: "/srv/work",
    workspaceParent: "/root/private", workspace: "/root/private/candidate", releaseRoot: "/var/lib/dp-release",
    journalPath: "/root/private/install.json", ownerId: "owner-ci", executionProfile: "full-shell" };
  const journal = { transactionId: "00000000-0000-4000-8000-000000000001", phase: "owner-ready",
    manifestSha256: "a".repeat(64), artifactSha256: "b".repeat(64), commit: "c".repeat(40), version: "0.1.0" };
  const report = { ...journal, domain: request.domain, expectedIp: request.expectedIp,
    policySha256: "d".repeat(64), installRoute: "signed-install-bound", publicIngress: "closed-exclusive",
    closure: "static-Caddy-profile" };
  const state = { request, journal, report, events: [], namespace: "net:[123]" };
  const clone = value => structuredClone(value);
  const args = { requestPath: "/root/private/request.json", policyPath: "/root/private/route.json",
    isRoot: () => true, isLinux: () => true,
    readRequest: async () => clone(state.request), readJournal: async () => clone(state.journal),
    stat: async () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }); },
    inspectIngress: async () => { state.events.push("ingress"); return clone(state.report); },
    advance: async options => {
      state.events.push("intent"); await options.inspectClosedIngress();
      assert.equal(options.transactionId, journal.transactionId); assert.equal(options.expectedPhase, "owner-ready");
      state.journal.phase = "startup-intent"; return clone(state.journal);
    },
    start: async options => {
      state.events.push("start"); await options.inspectClosedIngress();
      state.journal.phase = "startup-ready";
      return { transactionId: journal.transactionId, phase: "startup-ready", admission: "paused" };
    } };
  return { args, state };
}

test("OPS-01: protected startup gate requires matching initial/inspector/proxy namespaces and complete route correlation", async () => {
  const { state } = fixture();
  const args = { isRoot: () => true, isLinux: () => true, readOs: async () => 'ID=ubuntu\nVERSION_ID="24.04"\n',
    readNamespace: async () => state.namespace,
    inspectRoute: async () => ({ netNamespace: state.namespace }),
    inspectInstall: async options => {
      await options.inspectRoute({}); return { ...state.report, publicIngress: "unproven" };
    } };
  assert.equal((await inspectCleanClosedIngress(args)).publicIngress, "closed-exclusive");
  await assert.rejects(inspectCleanClosedIngress({ ...args, readNamespace: async name =>
    name === "/proc/1/ns/net" ? "net:[456]" : "net:[123]" }), /initial host network namespace/);
  await assert.rejects(inspectCleanClosedIngress({ ...args, inspectRoute: async () => ({ netNamespace: "net:[456]" }) }), /proxy differs/);
  await assert.rejects(inspectCleanClosedIngress({ ...args, inspectInstall: async () => ({ ...state.report, publicIngress: "unproven" }) }), /complete protected/);
  await assert.rejects(inspectCleanClosedIngress({ ...args, inspectInstall: async options => {
    await options.inspectRoute({}); state.namespace = "net:[456]";
    return { ...state.report, publicIngress: "unproven" };
  } }), /namespace changed/);
  await assert.rejects(inspectCleanClosedIngress({ ...args, isRoot: () => false }), /root Linux/);
  await assert.rejects(inspectCleanClosedIngress({ ...args, readOs: async () => 'ID=debian\nVERSION_ID="12"\n' }), /Ubuntu 24.04/);
});

test("OPS-01: protected operator keeps the same bound gate through intent/start/final result and permits only deliberate unlocked retry", async () => {
  const { args, state } = fixture(); const result = await startCleanProtected(args);
  assert.equal(result.localServices, "active"); assert.equal(result.admission, "paused");
  assert.equal(result.publicIngress, "closed-exclusive"); assert.equal(result.commit, state.journal.commit);
  assert.deepEqual(state.events, ["ingress", "intent", "ingress", "start", "ingress", "ingress"]);
  const retry = fixture(); retry.state.journal.phase = "startup-intent";
  await startCleanProtected(retry.args); assert.equal(retry.state.events.includes("intent"), false);
});

test("OPS-01: foreign or supporting-only route, interrupted locks and changed request cannot authorize a startup mutation", async () => {
  for (const change of [{ publicIngress: "unproven" }, { closure: "502-only" }, { domain: "other.example.com" },
    { expectedIp: "8.8.8.8" }, { transactionId: "00000000-0000-4000-8000-000000000002" },
    { artifactSha256: "f".repeat(64) }, { commit: "e".repeat(40) }]) {
    const { args, state } = fixture(); Object.assign(state.report, change);
    await assert.rejects(startCleanProtected(args)); assert.deepEqual(state.events, ["ingress"]);
  }
  for (const suffix of [".lock", ".startup-install.lock", ".startup-recovery.lock"]) {
    const { args, state } = fixture(); args.stat = async name => {
      if (name.endsWith(suffix)) return {};
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    };
    await assert.rejects(startCleanProtected(args), /unresolved lock/); assert.deepEqual(state.events, ["ingress"]);
  }
  const changed = fixture(); const advance = changed.args.advance;
  changed.args.advance = async options => {
    await advance(options); changed.state.request.ownerId = "other-owner";
  };
  await assert.rejects(startCleanProtected(changed.args), /Original startup request changed/);
  assert.equal(changed.state.journal.phase, "startup-intent");
  assert.equal(changed.state.events.at(-1), "start");
  const done = fixture(); done.state.journal.phase = "startup-ready";
  await assert.rejects(startCleanProtected(done.args), /not ready/); assert.deepEqual(done.state.events, []);
});

test("OPS-01: operator CLI rejects invalid arguments without echoing private values", async () => {
  const secret = "CLI_PRIVATE_VALUE_CANARY";
  await assert.rejects(exec(process.execPath, ["scripts/release/start-clean-protected.mjs", "--request", secret]), error => {
    assert.equal(error.code, 1); assert.equal(error.stdout, "");
    assert.match(error.stderr, /Protected clean startup refused or interrupted/);
    assert.equal(error.stderr.includes(secret), false); return true;
  });
});

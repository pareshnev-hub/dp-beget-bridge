import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectReleaseServices } from "../scripts/release/service-preflight.mjs";

async function rootFixture(t) {
  const releaseRoot = await mkdtemp(path.join(os.tmpdir(), "dp-service-preflight-"));
  t.after(() => rm(releaseRoot, { recursive: true, force: true }));
  const versionDir = `1.0.0-${"a".repeat(40)}`;
  await mkdir(path.join(releaseRoot, "releases", versionDir), { recursive: true });
  await symlink(`releases/${versionDir}`, path.join(releaseRoot, "current"));
  return { releaseRoot, versionDir };
}

function fixtureShow(releaseRoot, override = {}) {
  return async unit => {
    const user = unit.includes("session-host") ? "dp-work" : unit.includes("agent") ? "dp-agent" : "dp-mcp";
    const properties = { LoadState: "loaded", ActiveState: "active", User: user,
      WorkingDirectory: path.join(releaseRoot, "current"), KillMode: unit.includes("session-host") ? "process" : "control-group",
      ...override[unit] };
    if (unit.includes("tunnel")) properties.LoadState = "not-found";
    return Object.entries(properties).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
  };
}

test("OPS-07: read-only update preflight records the managed release and service state", async t => {
  const { releaseRoot, versionDir } = await rootFixture(t);
  const result = await inspectReleaseServices({ releaseRoot, showUnit: fixtureShow(releaseRoot) });
  assert.equal(result.versionDir, versionDir);
  assert.equal(result.units["dp-beget-session-host.service"], "active");
  assert.equal(result.units["dp-beget-tunnel.service"], "absent");
});

test("OPS-07: technical-preview working directory cannot be silently upgraded", async t => {
  const { releaseRoot } = await rootFixture(t);
  const showUnit = fixtureShow(releaseRoot, { "dp-beget-agent.service": { WorkingDirectory: "/opt/dp-beget-bridge" } });
  await assert.rejects(inspectReleaseServices({ releaseRoot, showUnit }), /not bound to the managed release/);
});

test("OPS-07: unsafe Session Host kill mode or missing required unit fails closed", async t => {
  const { releaseRoot } = await rootFixture(t);
  await assert.rejects(inspectReleaseServices({ releaseRoot, showUnit: fixtureShow(releaseRoot,
    { "dp-beget-session-host.service": { KillMode: "control-group" } }) }), /preserve tmux/);
  await assert.rejects(inspectReleaseServices({ releaseRoot, showUnit: fixtureShow(releaseRoot,
    { "dp-beget-agent.service": { LoadState: "not-found" } }) }), /unavailable/);
});

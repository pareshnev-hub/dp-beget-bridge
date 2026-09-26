import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildArtifact } from "../scripts/release/build-artifact.mjs";
import { pinReleaseKey } from "../scripts/release/pin-release-key.mjs";
import { signManifest } from "../scripts/release/sign-manifest.mjs";
import { renderCleanInstallUnits, stageCleanInstallUnits } from "../scripts/release/stage-clean-install-units.mjs";

const exec = promisify(execFile);
const names = ["dp-beget-session-host.service", "dp-beget-agent.service", "dp-beget-mcp.service"];
const options = { releaseRoot: "/opt/dp-versions", allowedRoot: "/srv/operator",
  workUser: "operator", workGroup: "operator", agentUser: "dp-agent",
  mcpUser: "dp-mcp", ipcGroup: "dp-ipc" };

test("OPS-01: clean-install units bind distinct users to a managed release", async () => {
  const templates = Object.fromEntries(await Promise.all(names.map(async name =>
    [name, await readFile(new URL(`../deploy/systemd/${name}`, import.meta.url), "utf8")])));
  const rendered = renderCleanInstallUnits({ templates, ...options });
  for (const unit of names) {
    assert.match(rendered[unit], /WorkingDirectory=\/opt\/dp-versions\/current\n/);
    assert.doesNotMatch(rendered[unit], /__DP_|WorkingDirectory=\/opt\/dp-beget-bridge\n/);
  }
  assert.match(rendered[names[0]], /User=operator\n/);
  assert.match(rendered[names[1]], /User=dp-agent\n/);
  assert.match(rendered[names[2]], /User=dp-mcp\n/);
  assert.match(rendered[names[0]], /KillMode=process\n/);
  assert.throws(() => renderCleanInstallUnits({ templates, ...options, agentUser: "operator" }), /separate/);
  assert.throws(() => renderCleanInstallUnits({ templates, ...options, allowedRoot: "/srv/work space" }), /Unsafe/);
  assert.throws(() => renderCleanInstallUnits({ templates, ...options,
    releaseRoot: "/srv/operator/releases" }), /separate/);
  assert.throws(() => renderCleanInstallUnits({ templates: { ...templates,
    [names[1]]: templates[names[1]] + "User=__DP_HIDDEN__\n" }, ...options }), /placeholders/);
});

test("OPS-01/05: only a pinned signed archive can stage inert private unit files", {
  skip: process.getuid?.() !== 0
}, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "dp-clean-units-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const commit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  const built = await buildArtifact({ commit, outputDir: path.join(base, "candidate") });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicBytes = publicKey.export({ format: "pem", type: "spki" });
  const publicFile = path.join(base, "public.pem");
  const privateFile = path.join(base, "private.pem");
  await writeFile(publicFile, publicBytes);
  await writeFile(privateFile, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const signature = path.join(base, "candidate", "manifest.sig");
  await signManifest({ ...built, privateKey: privateFile, signature });
  const parent = path.join(base, "private");
  await mkdir(parent, { mode: 0o700 });
  const trustDir = path.join(parent, "trust");
  await pinReleaseKey({ source: publicFile,
    expectedSha256: createHash("sha256").update(publicBytes).digest("hex"), trustDir });
  const stageDir = path.join(parent, "units");
  const args = { ...built, signature, trustDir, stageDir, ...options };
  const result = await stageCleanInstallUnits(args);
  assert.deepEqual(result.units, names);
  assert.equal((await stat(stageDir)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(stageDir, names[0]))).mode & 0o777, 0o600);
  assert.match(await readFile(path.join(stageDir, names[0]), "utf8"),
    /WorkingDirectory=\/opt\/dp-versions\/current\n/);
  await assert.rejects(stageCleanInstallUnits(args), /EEXIST/);
  await writeFile(built.artifact, "tampered archive");
  await assert.rejects(stageCleanInstallUnits({ ...args, stageDir: path.join(parent, "reject") }),
    /size mismatch/);
  await assert.rejects(stat(path.join(parent, "reject")), /ENOENT/);
  await chmod(parent, 0o755);
  await assert.rejects(stageCleanInstallUnits({ ...args, stageDir: path.join(parent, "unsafe") }),
    /private and root-owned/);
});

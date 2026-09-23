import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildArtifact } from "../scripts/release/build-artifact.mjs";
import { signManifest } from "../scripts/release/sign-manifest.mjs";
import { pinReleaseKey } from "../scripts/release/pin-release-key.mjs";
import { prepareRelease } from "../scripts/release/prepare-release.mjs";
import { promotePreparedRelease } from "../scripts/release/promote-prepared-release.mjs";
import { switchVersion } from "../scripts/release/version-pointer.mjs";

const exec = promisify(execFile);

test("OPS-05: root preparation enforces the separately pinned key before staging and extraction", { skip: process.getuid?.() !== 0 }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "dp-release-prepare-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const commit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  const built = await buildArtifact({ commit, outputDir: path.join(base, "candidate") });
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  const publicFile = path.join(base, "public.pem");
  const privateFile = path.join(base, "private.pem");
  await writeFile(publicFile, publicKey);
  await writeFile(privateFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const signature = path.join(base, "candidate", "manifest.sig");
  await signManifest({ ...built, privateKey: privateFile, signature });
  const parent = path.join(base, "secure");
  await mkdir(parent, { mode: 0o700 });
  const trustDir = path.join(parent, "trust");
  const fingerprint = createHash("sha256").update(publicKey).digest("hex");
  await pinReleaseKey({ source: publicFile, expectedSha256: fingerprint, trustDir });
  const workspace = path.join(parent, "release");
  const installed = [];
  const params = { ...built, signature, trustDir, workspace,
    installDependencies: async info => { installed.push(info); await mkdir(path.join(info.directory, "node_modules")); } };
  const result = await prepareRelease(params);
  assert.equal(installed.length, 1);
  assert.equal(installed[0].directory, result.directory);
  assert.equal(result.commit, commit);
  assert.equal(result.keyFingerprint, fingerprint);
  assert.equal((await stat(workspace)).mode & 0o777, 0o700);
  assert.equal(JSON.parse(await readFile(path.join(result.directory, "package.json"), "utf8")).name, "dp-beget-bridge");
  const releaseRoot = path.join(parent, "versions");
  await mkdir(path.join(releaseRoot, "releases"), { recursive: true, mode: 0o755 });
  const promoted = await promotePreparedRelease({ workspace, releaseRoot, trustDir });
  assert.equal(promoted.versionDir, `${result.version}-${commit}`);
  assert.equal((await stat(promoted.directory)).mode & 0o777, 0o755);
  assert.equal((await stat(path.join(promoted.directory, "package.json"))).mode & 0o777, 0o644);
  const switched = await switchVersion({ releaseRoot, versionDir: promoted.versionDir, checkHealthy: async () => {} });
  assert.equal(switched.current, `releases/${promoted.versionDir}`);
  await assert.rejects(promotePreparedRelease({ workspace, releaseRoot, trustDir }));
  await assert.rejects(prepareRelease(params), /EEXIST/);
  const tampered = path.join(parent, "tampered");
  await prepareRelease({ ...params, workspace: tampered });
  const tamperedPackage = path.join(tampered, "extracted", `dp-beget-bridge-${result.version}`, "package.json");
  await writeFile(tamperedPackage, (await readFile(tamperedPackage, "utf8")) + "\n");
  const tamperRoot = path.join(parent, "tamper-versions");
  await mkdir(path.join(tamperRoot, "releases"), { recursive: true, mode: 0o755 });
  await assert.rejects(promotePreparedRelease({ workspace: tampered, releaseRoot: tamperRoot, trustDir }),
    /differs from signed archive/);
  await writeFile(tamperedPackage, await readFile(path.join(promoted.directory, "package.json")));
  await symlink("/etc/passwd", path.join(tampered, "extracted", `dp-beget-bridge-${result.version}`, "node_modules", "outside"));
  await assert.rejects(promotePreparedRelease({ workspace: tampered, releaseRoot: tamperRoot, trustDir }),
    /absolute link/);
  await writeFile(built.artifact, "changed signed bytes");
  await assert.rejects(prepareRelease({ ...params, workspace: path.join(parent, "rejected") }), /size mismatch/);
  await assert.rejects(stat(path.join(parent, "rejected")), /ENOENT/);
});

test("OPS-05: CI root preparation installs production dependencies from the signed lockfile", {
  skip: process.getuid?.() !== 0 || process.env.DP_TEST_REAL_DEPENDENCIES !== "1"
}, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), "dp-release-deps-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const commit = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
  const built = await buildArtifact({ commit, outputDir: path.join(base, "candidate") });
  const keys = generateKeyPairSync("ed25519");
  const publicFile = path.join(base, "public.pem");
  const privateFile = path.join(base, "private.pem");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" });
  await writeFile(publicFile, publicKey);
  await writeFile(privateFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const signature = path.join(base, "candidate", "manifest.sig");
  await signManifest({ ...built, privateKey: privateFile, signature });
  const secure = path.join(base, "secure");
  await mkdir(secure, { mode: 0o700 });
  const trustDir = path.join(secure, "trust");
  await pinReleaseKey({ source: publicFile,
    expectedSha256: createHash("sha256").update(publicKey).digest("hex"), trustDir });
  const workspace = path.join(secure, "workspace");
  const result = await prepareRelease({ ...built, signature, trustDir, workspace });
  assert.equal(result.commit, commit);
  assert.ok((await stat(path.join(result.directory, "node_modules", "zod"))).isDirectory());
  await assert.rejects(stat(path.join(workspace, "npm-cache")), /ENOENT/);
  const releaseRoot = path.join(secure, "versions");
  await mkdir(path.join(releaseRoot, "releases"), { recursive: true, mode: 0o755 });
  const promoted = await promotePreparedRelease({ workspace, releaseRoot, trustDir });
  assert.equal(promoted.versionDir, `${result.version}-${commit}`);
  assert.ok((await stat(path.join(promoted.directory, "node_modules", "zod"))).isDirectory());
});

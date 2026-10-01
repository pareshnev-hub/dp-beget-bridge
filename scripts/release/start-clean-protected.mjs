#!/usr/bin/env node
import { lstat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readCleanPrivateRequest, parseCleanPrivateRequest } from "./install-clean-private.mjs";
import { readCleanInstallJournal, advanceCleanInstallJournal } from "./clean-install-journal.mjs";
import { inspectCleanClosedIngress } from "./inspect-clean-closed-ingress.mjs";
import { startCleanLocalServices } from "./start-clean-local-services.mjs";

// Starts only the already installed, signed, fresh-owner local application.
// Every transition/start/readiness check retains the actual closed-route gate.
// No service enablement, Caddy reconfiguration, pairing or admission resume.
export async function startCleanProtected({ requestPath, policyPath,
  readRequest = readCleanPrivateRequest, readJournal = readCleanInstallJournal,
  inspectIngress = inspectCleanClosedIngress, advance = advanceCleanInstallJournal,
  start = startCleanLocalServices, stat = lstat,
  isRoot = () => process.getuid?.() === 0, isLinux = () => process.platform === "linux" } = {}) {
  if (!isRoot() || !isLinux()) throw new Error("Root Linux is required for protected clean startup");
  const request = parseCleanPrivateRequest(Buffer.from(JSON.stringify(await readRequest(requestPath))));
  const journal = await readJournal(request.journalPath);
  if (!["owner-ready", "startup-intent"].includes(journal.phase)) throw new Error("Clean owner or retry intent is not ready");
  const inputs = { requestPath, policyPath, journalPath: request.journalPath, trustDir: request.trustDir };
  const inspectClosedIngress = async () => {
    if (!isDeepStrictEqual(request, await readRequest(requestPath))) throw new Error("Original startup request changed");
    const report = await inspectIngress(inputs);
    if (report?.publicIngress !== "closed-exclusive" || report.installRoute !== "signed-install-bound" ||
        report.closure !== "static-Caddy-profile" || report.transactionId !== journal.transactionId ||
        report.commit !== journal.commit || report.artifactSha256 !== journal.artifactSha256 ||
        report.manifestSha256 !== journal.manifestSha256 || report.domain !== request.domain ||
        report.expectedIp !== request.expectedIp || !/^[0-9a-f]{64}$/.test(report.policySha256 || "")) {
      throw new Error("Protected clean startup route is unproven");
    }
    return report;
  };
  await inspectClosedIngress(); // Before creating a journal transition lock.
  for (const suffix of [".lock", ".startup-install.lock", ".startup-recovery.lock"]) {
    try { await stat(`${request.journalPath}${suffix}`); throw new Error("Clean startup has an unresolved lock"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const common = { journalPath: request.journalPath, trustDir: request.trustDir, inspectClosedIngress };
  if (journal.phase === "owner-ready") {
    await advance({ ...common, transactionId: journal.transactionId,
      expectedPhase: "owner-ready", nextPhase: "startup-intent" });
  }
  const result = await start(common);
  if (result?.transactionId !== journal.transactionId || result.phase !== "startup-ready" || result.admission !== "paused") {
    throw new Error("Protected clean startup completion is unproven");
  }
  await inspectClosedIngress();
  return { transactionId: journal.transactionId, version: journal.version, commit: journal.commit,
    phase: result.phase, localServices: "active", admission: "paused", publicIngress: "closed-exclusive" };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== "--request" || args[2] !== "--policy") throw new Error("Invalid startup arguments");
    console.log(JSON.stringify(await startCleanProtected({ requestPath: args[1], policyPath: args[3] })));
  } catch {
    console.error("Protected clean startup refused or interrupted; admission stays paused; inspect the protected journal and locks before deliberate recovery");
    process.exitCode = 1;
  }
}

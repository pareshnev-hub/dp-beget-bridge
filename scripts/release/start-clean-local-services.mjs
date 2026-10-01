import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { verifyAdmissionPause } from "./admission-pause.mjs";
import { verifyCleanInstallManifest } from "./clean-install-manifest.mjs";
import { inspectCleanInstallIdentityPlan } from "./clean-install-identity-plan.mjs";
import { inspectCreatedCleanIdentities } from "./inspect-clean-install-created-identities.mjs";
import { inspectInstalledCleanConfig } from "./inspect-installed-clean-config.mjs";
import { inspectCleanStartupData } from "./clean-install-data-directories.mjs";
import { advanceCleanInstallJournal, readCleanInstallJournal,
  requireCleanClosedIngress } from "./clean-install-journal.mjs";
import { inspectCleanSystemdBoundary, inspectCleanRunningSystemd } from
  "./inspect-clean-systemd-boundary.mjs";
import { localReleaseHealthProbes, waitForAdmissionDrain } from "./wait-admission-drain.mjs";

const exec = promisify(execFile);
const START_ORDER = Object.freeze(["dp-beget-session-host.service",
  "dp-beget-agent.service", "dp-beget-mcp.service"]);

async function systemctl(action, unit) {
  await exec("systemctl", [action, unit], { timeout: 20000, maxBuffer: 4096 });
}

async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

// This is an installer API, not a public CLI. Its default route verifier
// rejects all starts until a supported reverse-proxy proof is implemented.
export async function startCleanLocalServices({ journalPath, trustDir,
  configDir = "/etc/dp-beget-bridge", unitDirectory = "/etc/systemd/system",
  dataRoot = "/var/lib", inspectInactive = inspectCleanSystemdBoundary,
  inspectRunning = inspectCleanRunningSystemd,
  inspectPaused = verifyAdmissionPause,
  verify = verifyCleanInstallManifest,
  inspectPlan = inspectCleanInstallIdentityPlan,
  inspectCreated = inspectCreatedCleanIdentities,
  inspectConfig = inspectInstalledCleanConfig,
  inspectData = inspectCleanStartupData,
  inspectClosedIngress = requireCleanClosedIngress,
  inspectHealth = () => waitForAdmissionDrain({ probes: localReleaseHealthProbes() }),
  startUnit = unit => systemctl("start", unit),
  stopUnit = unit => systemctl("stop", unit),
  advance = advanceCleanInstallJournal } = {}) {
  if (process.getuid?.() !== 0) throw new Error("Root is required to start clean local services");
  const journal = await readCleanInstallJournal(journalPath);
  if (journal.phase !== "startup-intent") throw new Error("Clean startup requires journaled intent");
  async function preflight() {
    try {
      await lstat(`${journalPath}.lock`);
      throw new Error("Clean-install journal transition has an unresolved lock");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const candidate = await verify({ workspace: journal.workspace,
      manifestSha256: journal.manifestSha256, trustDir });
    if (candidate.artifactSha256 !== journal.artifactSha256 ||
        candidate.version !== journal.version || candidate.commit !== journal.commit ||
        JSON.stringify(await inspectPlan({ workspace: journal.workspace,
          manifestSha256: journal.manifestSha256, trustDir })) !==
          JSON.stringify(journal.identityPlan)) {
      throw new Error("Signed clean candidate changed before local startup");
    }
    const identities = await inspectCreated({ plan: journal.identityPlan,
      transactionId: journal.transactionId });
    if (identities?.identities !== "journal-bound" ||
        (await inspectConfig({ configDir, workspace: journal.workspace,
          manifestSha256: journal.manifestSha256, trustDir,
          identityPlan: journal.identityPlan, identities }))?.config !== "bound-private" ||
        (await inspectData({ dataRoot, plan: journal.identityPlan,
          identities }))?.data !== "private-owned" ||
        (await inspectInactive({ journalPath, trustDir, unitDirectory }))?.localSystemd !== "inactive-bound" ||
        (await inspectPaused())?.paused !== true ||
        (await inspectClosedIngress())?.publicIngress !== "closed-exclusive") {
      throw new Error("Clean local startup boundary is unproven");
    }
  }
  await preflight();
  const parent = path.dirname(journalPath);
  const lock = `${journalPath}.startup-install.lock`;
  const handle = await open(lock,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${journal.transactionId}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await syncDirectory(parent);
  const started = [];
  let committed = false;
  try {
    await preflight();
    for (const unit of START_ORDER) {
      if ((await inspectPaused())?.paused !== true ||
          (await inspectClosedIngress())?.publicIngress !== "closed-exclusive") {
        throw new Error("Clean route or admission changed during startup");
      }
      // Track before starting: systemctl may fail after creating a process.
      started.push(unit);
      await startUnit(unit);
    }
    // Type=simple only proves systemd forked the process. Wait for bounded
    // application readiness before requiring its actual bound listeners.
    if ((await inspectHealth())?.drained !== true ||
        (await inspectRunning({ journalPath, trustDir, unitDirectory }))?.localSystemd !== "active-bound" ||
        (await inspectPaused())?.paused !== true ||
        (await inspectClosedIngress())?.publicIngress !== "closed-exclusive") {
      throw new Error("Clean running services, admission or public route are unproven");
    }
    const next = await advance({ journalPath, transactionId: journal.transactionId,
      expectedPhase: "startup-intent", nextPhase: "startup-ready",
      configDir, unitDirectory, dataRoot, trustDir,
      inspectClosedIngress, inspectRunning, inspectHealth, inspectPaused });
    committed = true;
    await unlink(lock);
    await syncDirectory(parent);
    return { transactionId: next.transactionId, phase: next.phase,
      services: [...START_ORDER], admission: "paused" };
  } catch (error) {
    // An interrupted journal commit may already say startup-ready. Keep the
    // paused services and lock together for deliberate recovery in that case.
    if (committed || (await readCleanInstallJournal(journalPath).catch(() => null))?.phase === "startup-ready") {
      throw error;
    }
    if (started.length === 0) {
      await unlink(lock).catch(() => {});
      await syncDirectory(parent);
      throw error;
    }
    const failures = [];
    for (const unit of started.reverse()) {
      try { await stopUnit(unit); }
      catch (stopError) { failures.push(stopError); }
    }
    if (failures.length) {
      throw new AggregateError([error, ...failures],
        "Clean local startup and stop failed; admission and startup lock remain");
    }
    throw error;
  }
}

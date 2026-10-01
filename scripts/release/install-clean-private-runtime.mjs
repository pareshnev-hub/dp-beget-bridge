import { lstat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { startCleanInstallJournal, readCleanInstallJournal, advanceCleanInstallJournal } from "./clean-install-journal.mjs";
import { inspectCleanInstallIdentityPlan } from "./clean-install-identity-plan.mjs";
import { inspectCleanInstallIdentities } from "./preflight-clean-install-identities.mjs";
import { inspectCleanInstallTargets, inspectCleanInstallListeners } from "./preflight-clean-install.mjs";
import { inspectCleanDataTargets } from "./clean-install-data-directories.mjs";
import { installCleanIdentities } from "./install-clean-identities.mjs";
import { installCleanConfig } from "./install-clean-config.mjs";
import { installCleanUnits } from "./install-clean-units.mjs";
import { installCleanData } from "./install-clean-data.mjs";
import { installCleanReleaseRoot } from "./clean-install-release-root.mjs";
import { promoteCleanInstall } from "./promote-clean-install.mjs";
import { installCleanPointer } from "./install-clean-pointer.mjs";
import { loadCleanSystemdUnits } from "./load-clean-systemd-units.mjs";
import { installCleanAdmissionPause, inspectCleanAdmissionTarget } from "./install-clean-admission-pause.mjs";
import { inspectCleanSystemdBoundary } from "./inspect-clean-systemd-boundary.mjs";
import { verifyAdmissionPause } from "./admission-pause.mjs";

const STEPS = Object.freeze([
  ["identities", installCleanIdentities], ["config", installCleanConfig],
  ["units", installCleanUnits], ["data", installCleanData],
  ["release-root", installCleanReleaseRoot], ["promotion", promoteCleanInstall],
  ["pointer", installCleanPointer], ["systemd", loadCleanSystemdUnits],
  ["admission", installCleanAdmissionPause],
]);

async function inspectFreshTargets({ journal, trustDir }) {
  const plan = await inspectCleanInstallIdentityPlan({ workspace: journal.workspace,
    manifestSha256: journal.manifestSha256, trustDir });
  if (!isDeepStrictEqual(plan, journal.identityPlan)) throw new Error("Clean private plan changed");
  await inspectCleanInstallTargets({ releaseRoot: journal.releaseRoot,
    workspaceParent: path.dirname(journal.workspace) });
  await inspectCleanInstallListeners();
  await inspectCleanInstallIdentities(plan);
  await inspectCleanDataTargets();
  await inspectCleanAdmissionTarget();
}

// Fresh private installation only. Never retries an existing journal, starts
// or enables services, opens ingress, resumes admission, or purges data.
// Every live phase delegates to its existing signed/journaled primitive.
export async function installCleanPrivateRuntime({ journalPath, workspace, manifestSha256,
  releaseRoot, trustDir, startJournal = startCleanInstallJournal,
  readJournal = readCleanInstallJournal, advance = advanceCleanInstallJournal,
  inspectTargets = inspectFreshTargets, inspectSystemd = inspectCleanSystemdBoundary,
  inspectPaused = verifyAdmissionPause, installers = {},
  isRoot = () => process.getuid?.() === 0 } = {}) {
  if (!isRoot()) throw new Error("Root is required to install clean private runtime");
  if (typeof journalPath !== "string" || !path.isAbsolute(journalPath) ||
      path.normalize(journalPath) !== journalPath || !installers || typeof installers !== "object" ||
      Array.isArray(installers) || Object.keys(installers).some(key =>
        !STEPS.some(([name]) => name === key) || typeof installers[key] !== "function")) {
    throw new Error("Invalid clean private controller inputs");
  }
  // Reject all pre-existing journal paths, including symlinks, before doing
  // any live work. The production creator additionally validates the parent
  // and enforces exclusive no-follow creation, closing the check/create race.
  try { await lstat(journalPath); throw new Error("Clean private installation requires a fresh journal"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const journal = await startJournal({ journalPath, workspace, manifestSha256, releaseRoot, trustDir });
  if (!journal || journal.phase !== "prepared" || journal.workspace !== workspace ||
      journal.manifestSha256 !== manifestSha256 || journal.releaseRoot !== releaseRoot ||
      typeof journal.transactionId !== "string") throw new Error("Fresh clean private journal is unproven");
  const common = { journalPath, trustDir };
  const inspectPhase = async phase => {
    if (!isDeepStrictEqual(await readJournal(journalPath), { ...journal, phase })) {
      throw new Error("Clean private transaction identity or phase changed");
    }
  };
  let phase = "prepared", stage = "preflight";
  try {
    await inspectPhase(phase);
    await inspectTargets({ journal, trustDir });
    for (const [name, productionInstall] of STEPS) {
      stage = name;
      await inspectPhase(phase);
      const intent = `${name}-intent`, ready = `${name}-ready`;
      await advance({ ...common, transactionId: journal.transactionId, expectedPhase: phase, nextPhase: intent });
      phase = intent;
      await inspectPhase(phase);
      await (installers[name] || productionInstall)({ ...common,
        advance: async transition => {
          if (transition.transactionId !== journal.transactionId || transition.journalPath !== journalPath ||
              transition.expectedPhase !== intent || transition.nextPhase !== ready) {
            throw new Error("Clean private primitive attempted an unexpected transition");
          }
          return advance({ ...transition, ...common });
        } });
      phase = ready;
      await inspectPhase(phase);
    }
    stage = "final-verification";
    if ((await inspectSystemd(common))?.localSystemd !== "inactive-bound" ||
        (await inspectPaused())?.paused !== true) {
      throw new Error("Clean private final inactive/paused boundary is unproven");
    }
    await inspectPhase("admission-ready");
    return { transactionId: journal.transactionId, phase: "admission-ready",
      version: journal.version, commit: journal.commit, localServices: "inactive",
      admission: "paused", publicIngress: "unproven" };
  } catch (cause) {
    const error = new Error(`Clean private installation stopped during ${stage}; journal retained for deliberate recovery`, { cause });
    error.code = "CLEAN_PRIVATE_INSTALL_STOPPED";
    throw error;
  }
}

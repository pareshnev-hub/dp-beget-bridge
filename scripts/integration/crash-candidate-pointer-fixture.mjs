import { unlink } from "node:fs/promises";
import { deactivateCandidatePointer } from "../release/deactivate-candidate-pointer.mjs";

// CI child process: the journal is already in 'removing' when unlink succeeds.
// Exit before the release-directory sync or 'removed' transition.
const paths = JSON.parse(process.argv[2]);
await deactivateCandidatePointer({
  ...paths,
  getState: async () => "inactive", getIngressState: async () => "inactive",
  getWriterState: async () => "inactive", verifyPaused: async () => {},
  assertLedgerSafe: async () => {}, inspectGuard: async () => {},
  inspectWriterGuards: async () => {}, assertRouteExclusive: async () => true,
  unlinkPointer: async filename => { await unlink(filename); process.exit(82); }
});
process.exitCode = 83;

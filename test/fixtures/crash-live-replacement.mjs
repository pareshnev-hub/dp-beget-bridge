import { rename } from "node:fs/promises";
import { replaceLiveStateFromLedger } from "../../scripts/release/live-state-replacement-ledger.mjs";

// CI child process: exit immediately after a real rename, before its directory
// sync or any in-memory exception handler can run. The parent must recover.
const paths = JSON.parse(process.argv[2]);
const crashAfter = Number(process.argv[3]);
let renames = 0;
await replaceLiveStateFromLedger({
  ...paths,
  getState: async () => "inactive", getIngressState: async () => "inactive",
  getWriterState: async () => "inactive", verifyPaused: async () => {},
  assertLedgerSafe: async () => {}, inspectGuard: async () => {},
  inspectWriterGuards: async () => {}, assertRouteExclusive: async () => true,
  renameEntry: async (source, destination) => {
    await rename(source, destination);
    if (++renames === crashAfter) process.exit(82);
  }
});
process.exitCode = 83; // Unexpectedly completed without reaching the crash point.

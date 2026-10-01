import test from "node:test";
import assert from "node:assert/strict";
import { rehearseCleanPrivateAutonomy } from "../scripts/integration/clean-private-autonomy.mjs";

test("AUTO-01..04: fault injection cannot be invoked as an ordinary installer or against a production journal", async () => {
  await assert.rejects(rehearseCleanPrivateAutonomy({ journalPath: "/production-install/journal.json" }),
    /Explicit disposable root autonomy fixture required/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { validateBasicWorkspaceAcl } from "../scripts/release/clean-install-workspace.mjs";

test("OPS-01: clean workspace sharing rejects named/default ACLs and outside access", () => {
  const basic = "user::rwx\ngroup::---\nother::---\n\n";
  validateBasicWorkspaceAcl(basic, "---");
  validateBasicWorkspaceAcl(basic.replace("group::---", "group::rwx"), "rwx");
  for (const source of [undefined, "", basic.replace("other::---", "other::r-x"),
    basic.replace("group::---", "group::rwx"), basic + "default:user::rwx\n",
    basic.replace("group::---", "user:1001:rwx\ngroup::---\nmask::rwx"),
    basic.replace("group::---", "group:1001:rwx\ngroup::---\nmask::rwx")]) {
    assert.throws(() => validateBasicWorkspaceAcl(source, "---"), /basic private permissions/);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { DownloadTokenStore } from "../apps/mcp/src/download-tokens.js";

test("issues opaque short-lived download tokens", () => {
  const store = new DownloadTokenStore({ ttlMs: 1000 });
  const issued = store.issue("/srv/file.txt");
  assert.ok(issued.token.length >= 40);
  assert.equal(store.get(issued.token).filePath, "/srv/file.txt");
  assert.equal(store.get("not-a-token"), null);
});

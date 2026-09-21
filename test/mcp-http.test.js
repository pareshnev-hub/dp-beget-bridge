import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHttpServer } from "../apps/mcp/src/server.js";
import { DownloadTokenStore } from "../apps/mcp/src/download-tokens.js";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const agent = {
  capabilities: async () => ({ product: "DP Beget Bridge", protocolVersion: "1.0" }),
};
const fileContract = JSON.parse(readFileSync(
  new URL("./fixtures/openai-file-input-contract.2026-09-21.json", import.meta.url),
  "utf8",
));

test("MCP endpoint requires its configured bearer and exposes tools", async (t) => {
  const config = {
    path: "/mcp",
    publicUrl: "https://bridge.example.test",
    accessToken: "a".repeat(32),
  };
  const server = createMcpHttpServer({
    config,
    agent,
    downloads: new DownloadTokenStore({ ttlMs: 1000 }),
    logger,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/mcp`;

  const denied = await fetch(endpoint, { method: "POST" });
  assert.equal(denied.status, 401);

  const initialized = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    }),
  });
  assert.equal(initialized.status, 200);
  const body = await initialized.json();
  assert.equal(body.result.serverInfo.name, "dp-beget-bridge");
});

test("DP-003: file descriptors and results match the captured ChatGPT contract", async (t) => {
  const uploaded = [];
  const sha256 = "a".repeat(64);
  const config = {
    path: "/mcp",
    publicUrl: "https://bridge.example.test",
    accessToken: "b".repeat(32),
  };
  const contractAgent = {
    async uploadFromUrl(file, destination, overwrite) {
      uploaded.push({ file, destination, overwrite });
      return { path: `/workspace/${destination}`, size: 7, sha256 };
    },
  };
  const server = createMcpHttpServer({
    config,
    agent: contractAgent,
    downloads: new DownloadTokenStore({ ttlMs: 1000 }),
    logger,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const client = new Client({ name: "dp003-contract-test", version: fileContract.target_client.contract_snapshot });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${config.accessToken}` } },
  });
  await client.connect(transport);
  t.after(() => client.close());

  const listed = await client.listTools();
  const tools = Object.fromEntries(listed.tools.map((tool) => [tool.name, tool]));
  const upload = tools.upload_files;
  const fileItem = upload.inputSchema.properties.files.items;

  assert.deepEqual(Object.keys(fileItem.properties).sort(), [...fileContract.file_object.properties].sort());
  assert.deepEqual([...fileItem.required].sort(), [...fileContract.file_object.required].sort());
  assert.equal(fileItem.additionalProperties, false);
  assert.deepEqual(upload._meta["openai/fileParams"], ["files"]);
  assert.equal(upload.annotations.readOnlyHint, false);
  assert.equal(upload.annotations.destructiveHint, true);
  assert.equal(upload.annotations.openWorldHint, true);
  assert.ok(upload.outputSchema.properties.uploaded);

  for (const name of ["list_files", "download_file", "copy_path", "move_path", "delete_path"]) {
    assert.ok(tools[name].outputSchema, `${name} must declare its structured output`);
  }
  assert.equal(tools.copy_path.annotations.destructiveHint, true);
  assert.equal(tools.move_path.annotations.destructiveHint, true);
  assert.equal(tools.delete_path.annotations.destructiveHint, true);
  assert.equal(tools.download_file.annotations.readOnlyHint, true);

  const result = await client.callTool({
    name: "upload_files",
    arguments: {
      files: [{
        download_url: fileContract.sample.download_url,
        file_id: fileContract.sample.file_id,
      }],
      destination_directory: "incoming",
    },
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent, {
    uploaded: [{ path: uploaded[0].destination.replace("incoming/", "/workspace/incoming/"), size: 7, sha256 }],
  });
  assert.match(uploaded[0].destination, /^incoming\/attachment-[a-f0-9]{16}$/);
  assert.equal(uploaded[0].file.file_name, undefined);
  assert.equal(uploaded[0].file.mime_type, undefined);
  assert.equal(uploaded[0].overwrite, false);

  let rejectedMissingIdentity = false;
  try {
    const invalid = await client.callTool({
      name: "upload_files",
      arguments: {
        files: [{ download_url: fileContract.sample.download_url }],
      },
    });
    rejectedMissingIdentity = invalid.isError === true;
  } catch {
    rejectedMissingIdentity = true;
  }
  assert.equal(rejectedMissingIdentity, true, "file_id must be enforced at the protocol boundary");
  assert.equal(uploaded.length, 1, "invalid file input must not reach the Agent");
});

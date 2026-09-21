import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { AgentClient } from "../../apps/mcp/src/agent-client.js";
import {
  AttachmentFetcher,
  isPublicAttachmentAddress,
} from "../../packages/core/src/attachment-fetch.js";

function response(statusCode, headers = {}, chunks = []) {
  const body = Readable.from(chunks);
  return {
    statusCode,
    headers,
    body,
    destroy(error) { body.destroy(error); },
  };
}

async function readBody(source) {
  return Buffer.from(await new Response(source.body).arrayBuffer());
}

test("SSRF-01: IPv4 loopback is blocked before a request opens", async () => {
  let opened = false;
  const fetcher = new AttachmentFetcher({ open: async () => { opened = true; } });
  await assert.rejects(fetcher.fetch("https://127.0.0.1/file"), { code: "attachment_address_blocked" });
  assert.equal(opened, false);
});

test("SSRF-02: IPv6 loopback is blocked before a request opens", async () => {
  let opened = false;
  const fetcher = new AttachmentFetcher({ open: async () => { opened = true; } });
  await assert.rejects(fetcher.fetch("https://[::1]/file"), { code: "attachment_address_blocked" });
  assert.equal(opened, false);
});

test("SSRF-03: private, link-local, mixed DNS and non-HTTPS targets are denied", async () => {
  for (const address of ["10.0.0.1", "172.16.1.1", "192.168.1.1", "169.254.169.254", "fc00::1", "fe80::1"]) {
    assert.equal(isPublicAttachmentAddress(address), false, address);
  }
  assert.equal(isPublicAttachmentAddress("93.184.216.34"), true);
  assert.equal(isPublicAttachmentAddress("2606:4700:4700::1111"), true);
  assert.equal(isPublicAttachmentAddress("2002:7f00:0001::"), false);

  let opened = false;
  const fetcher = new AttachmentFetcher({
    resolve: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
    open: async () => { opened = true; },
  });
  await assert.rejects(fetcher.fetch("https://mixed.example/file"), { code: "attachment_address_blocked" });
  await assert.rejects(fetcher.fetch("http://public.example/file"), { code: "attachment_url_blocked" });
  await assert.rejects(fetcher.fetch("https://public.example:8443/file"), { code: "attachment_url_blocked" });
  assert.equal(opened, false);
});

test("SSRF-04: every redirect is resolved again and private redirect targets are blocked", async () => {
  const opened = [];
  const fetcher = new AttachmentFetcher({
    resolve: async (hostname) => hostname === "public.example"
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "10.0.0.8", family: 4 }],
    open: async ({ url }) => {
      opened.push(url.hostname);
      return response(302, { location: "https://private.example/secret" });
    },
  });
  await assert.rejects(fetcher.fetch("https://public.example/file"), { code: "attachment_address_blocked" });
  assert.deepEqual(opened, ["public.example"]);
});

test("SSRF-05: a slow body is aborted by the overall deadline", async () => {
  const slow = new PassThrough();
  const fetcher = new AttachmentFetcher({
    timeoutMs: 25,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    open: async () => ({
      statusCode: 200,
      headers: {},
      body: slow,
      destroy(error) { slow.destroy(error); },
    }),
  });
  const source = await fetcher.fetch("https://public.example/slow");
  await assert.rejects(readBody(source), { code: "attachment_timeout" });
  assert.equal(slow.destroyed, true);
});

test("SSRF-06: a streaming response above the byte ceiling is rejected", async () => {
  const fetcher = new AttachmentFetcher({
    maxBytes: 5,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    open: async () => response(200, {}, [Buffer.from("123"), Buffer.from("456")]),
  });
  const source = await fetcher.fetch("https://public.example/large");
  await assert.rejects(readBody(source), { code: "attachment_too_large" });
});

test("SSRF-07: caller disconnect aborts the upstream stream", async () => {
  const upstream = new PassThrough();
  const caller = new AbortController();
  const fetcher = new AttachmentFetcher({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    open: async () => ({
      statusCode: 200,
      headers: {},
      body: upstream,
      destroy(error) { upstream.destroy(error); },
    }),
  });
  const source = await fetcher.fetch("https://public.example/disconnect", { signal: caller.signal });
  caller.abort();
  await assert.rejects(readBody(source), { code: "attachment_cancelled" });
  assert.equal(upstream.destroyed, true);
});

test("SSRF-08: service bearer credentials never reach the source origin", async () => {
  const sourceRequests = [];
  const fetcher = new AttachmentFetcher({
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    open: async (request) => {
      sourceRequests.push(request);
      return response(200, { "content-type": "text/untrusted" }, [Buffer.from("payload")]);
    },
  });
  const agent = new AgentClient({
    baseUrl: "http://127.0.0.1:8787",
    token: "agent-secret-bearer-value",
    attachmentFetcher: fetcher,
  });
  agent.request = async (_path, options) => {
    assert.equal((await new Response(options.body).text()), "payload");
    assert.equal(options.headers["content-type"], "application/octet-stream");
    return new Response(JSON.stringify({ path: "/workspace/file", size: 7, sha256: "a".repeat(64) }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  await agent.uploadFromUrl(
    { download_url: "https://public.example/file", file_id: "file_safe" },
    "file",
    false,
  );
  assert.equal(sourceRequests.length, 1);
  assert.deepEqual(sourceRequests[0].headers, { accept: "application/octet-stream" });
  assert.equal(sourceRequests[0].address, "93.184.216.34");
  assert.equal(JSON.stringify(sourceRequests[0]).includes("agent-secret-bearer-value"), false);
});

test("attachment deadline also bounds DNS resolution", async () => {
  const fetcher = new AttachmentFetcher({
    timeoutMs: 20,
    resolve: async () => new Promise(() => {}),
    open: async () => { throw new Error("must not open"); },
  });
  await assert.rejects(fetcher.fetch("https://slow-dns.example/file"), { code: "attachment_timeout" });
});

test("attachment fetch concurrency is rejected instead of queued without bound", async () => {
  const held = new PassThrough();
  const fetcher = new AttachmentFetcher({
    maxConcurrent: 1,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    open: async () => ({
      statusCode: 200,
      headers: {},
      body: held,
      destroy(error) { held.destroy(error); },
    }),
  });
  const first = await fetcher.fetch("https://public.example/first");
  await assert.rejects(fetcher.fetch("https://public.example/second"), { code: "attachment_busy" });
  first.dispose();
});

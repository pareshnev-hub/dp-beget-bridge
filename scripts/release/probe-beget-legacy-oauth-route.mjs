#!/usr/bin/env node
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "bridge-oauth.pareshnev.com";
const PUBLIC_IP = "45.12.238.143";
const METADATA = `https://${HOST}/.well-known/oauth-protected-resource`;
const EXPECTED_CHALLENGE = `Bearer resource_metadata="${METADATA}", scope="terminal:read terminal:execute terminal:input terminal:close files:read files:write"`;
const TARGETS = Object.freeze([
  { label: "local", protocol: "http:", hostname: "127.0.0.1", port: 8789 },
  { label: "socket", protocol: "http:", hostname: "172.18.0.1", port: 8791 },
  { label: "public", protocol: "https:", hostname: PUBLIC_IP, port: 443,
    servername: HOST, rejectUnauthorized: true }
]);

function fail(reason) { throw new Error(`Beget legacy OAuth route: ${reason}`); }

function requestChallenge(target) {
  const client = target.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request({ ...target, method: "GET", path: "/mcp", agent: false,
      headers: { Host: HOST, Accept: "application/json", Connection: "close" },
      maxHeaderSize: 8192, timeout: 8000 }, response => {
      const chunks = [];
      let bytes = 0;
      response.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > 4096) response.destroy(new Error("OAuth response exceeded limit"));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode,
        headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on("timeout", () => request.destroy(new Error("OAuth request timed out")));
    request.on("error", reject);
    request.end();
  });
}

// A real public 401 must match the response reached through the dedicated
// systemd socket and directly at the R0003 OAuth loopback listener. It does
// not prove the absence of other ingress or serve as assertRouteExclusive.
export function validateBegetLegacyOAuthResponses(responses) {
  if (!Array.isArray(responses) || responses.length !== TARGETS.length) {
    fail("missing route response");
  }
  const fingerprints = responses.map((response, index) => {
    const headers = response?.headers;
    if (response?.status !== 401 || !headers ||
      headers["www-authenticate"] !== EXPECTED_CHALLENGE ||
      headers["content-type"] !== "application/json; charset=utf-8" ||
      headers["cache-control"] !== "no-store" || headers.location !== undefined ||
      !Buffer.isBuffer(response.body) || response.body.length > 4096) {
      fail(`unexpected ${TARGETS[index].label} challenge`);
    }
    let body;
    try { body = JSON.parse(response.body.toString("utf8")); }
    catch { fail("invalid OAuth response JSON"); }
    if (body?.error?.code !== "unauthorized") fail("unexpected OAuth response identity");
    return createHash("sha256").update(response.body).digest("hex");
  });
  if (new Set(fingerprints).size !== 1) fail("public and private challenge bodies differ");
  return { status: 401, hops: TARGETS.map(target => target.label),
    bodySha256: fingerprints[0], scope: "R0003 response parity only" };
}

export async function probeBegetLegacyOAuthRoute({ request = requestChallenge } = {}) {
  const responses = [];
  for (const target of TARGETS) responses.push(await request(target));
  return validateBegetLegacyOAuthResponses(responses);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  probeBegetLegacyOAuthRoute().then(report => {
    console.log(`Beget legacy OAuth response parity passed (${report.hops.join(" → ")})`);
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

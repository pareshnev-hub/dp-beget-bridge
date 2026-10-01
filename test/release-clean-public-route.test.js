import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { probeCleanPublicRoute, requestCleanPublicRoute } from
  "../scripts/release/probe-clean-public-route.mjs";
import { requireCleanClosedIngress } from "../scripts/release/clean-install-journal.mjs";

const binding = { domain: "bridge.example.com", expectedIp: "1.1.1.1" };
const host = async input => ({ ...input, dns: "pass", tls: "pass" });
const closed = () => ({ status: 502, headers: {}, body: Buffer.from("Bad Gateway") });

function transport(emit, inspect = () => {}) {
  const state = { requestDestroyed: false, responseDestroyed: false };
  state.httpsRequest = (options, callback) => {
    inspect(options);
    const request = new EventEmitter();
    request.destroy = () => { state.requestDestroyed = true; };
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 502;
      response.headers = {};
      response.complete = false;
      response.destroy = () => { state.responseDestroyed = true; };
      callback(response);
      emit(response, request);
    });
    return request;
  };
  return state;
}

test("OPS-01: clean route observation binds the new host twice but cannot authorize startup", async () => {
  const calls = [];
  const report = await probeCleanPublicRoute({ ...binding,
    domain: "BRIDGE.example.com",
    inspectHost: async input => { calls.push("host"); assert.deepEqual(input, binding); return host(input); },
    request: async input => { calls.push("request"); assert.deepEqual(input, binding); return closed(); } });
  assert.deepEqual(calls, ["host", "request", "host"]);
  assert.deepEqual(report, { ...binding, path: "/mcp", status: 502,
    publicResponse: "closed-upstream", publicIngress: "unproven" });
  assert.throws(requireCleanClosedIngress, /verified closed public route/);
});

test("OPS-01: clean probe refuses unsafe targets before network access", async () => {
  for (const change of [
    { domain: "https://bridge.example.com" }, { domain: "bridge.example.com/mcp" },
    { domain: "bridge.example.com\r\nHost: attacker.example" },
    { expectedIp: "127.0.0.1" }, { expectedIp: "169.254.169.254" },
    { expectedIp: "10.0.0.1" }, { expectedIp: "::1" }, { expectedIp: "another.example.com" },
  ]) {
    const options = { ...binding, ...change };
    await assert.rejects(probeCleanPublicRoute({ ...options,
      inspectHost: () => assert.fail("unsafe host inspection"),
      request: () => assert.fail("unsafe request") }), /hostname|IPv4/);
    assert.throws(() => requestCleanPublicRoute({ ...options,
      httpsRequest: () => assert.fail("unsafe transport") }), /hostname|IPv4/);
  }
});

test("OPS-01: changed DNS or TLS evidence on either side rejects the public observation", async () => {
  for (const key of ["domain", "expectedIp", "dns", "tls"]) {
    for (const failAt of [1, 2]) {
      let count = 0, requests = 0;
      await assert.rejects(probeCleanPublicRoute({ ...binding,
        inspectHost: async input => ({ ...await host(input),
          ...(++count === failAt ? { [key]: "changed" } : {}) }),
        request: async () => { requests++; return closed(); } }), /binding is unproven/);
      assert.equal(requests, failAt === 1 ? 0 : 1);
    }
  }
});

test("OPS-01: live auth, redirect, admission response and malformed bodies cannot count as closure", async () => {
  for (const response of [null, { ...closed(), status: 200 }, { ...closed(), status: 401 },
    { ...closed(), status: 302 }, { ...closed(), status: 503 },
    ...["location", "www-authenticate", "proxy-authenticate"].map(key =>
      ({ ...closed(), headers: { [key]: "unexpected" } })),
    { ...closed(), body: Buffer.alloc(4097) }, { ...closed(), body: "Bad Gateway" }]) {
    await assert.rejects(probeCleanPublicRoute({ ...binding, inspectHost: host,
      request: async () => response }), /closed-upstream response/);
  }
});

test("OPS-01: transport pins IP, Host and TLS identity and sends only a bounded credential-free GET", async () => {
  const fake = transport(response => {
    response.emit("data", Buffer.from("Bad Gateway"));
    response.complete = true;
    response.emit("end");
    response.emit("close");
  }, options => {
    assert.equal(options.hostname, binding.expectedIp);
    assert.equal(options.servername, binding.domain);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.protocol, "https:");
    assert.equal(options.port, 443);
    assert.equal(options.method, "GET");
    assert.equal(options.path, "/mcp");
    assert.equal(options.agent, false);
    assert.equal(options.maxHeaderSize, 8192);
    assert.deepEqual(options.headers, { Host: binding.domain, Accept: "application/json",
      Connection: "close", "Cache-Control": "no-store" });
    assert.equal(options.auth, undefined);
  });
  assert.deepEqual(await requestCleanPublicRoute({ ...binding, httpsRequest: fake.httpsRequest }), closed());
  assert.equal(fake.requestDestroyed, false);
});

test("OPS-01: transport destroys oversized and incomplete responses without leaking remote errors", async () => {
  const cases = [
    [response => { response.emit("data", Buffer.alloc(4096)); response.emit("data", Buffer.alloc(1)); }, /body exceeds limit/],
    [response => response.emit("aborted"), /response incomplete/],
    [response => response.emit("end"), /response incomplete/],
    [response => response.emit("close"), /response incomplete/],
    [response => response.emit("error", new Error("REMOTE_SECRET")), /response failed/],
    [(_response, request) => request.emit("error", new Error("REMOTE_SECRET")), /TLS or connection failed/],
  ];
  for (const [emit, pattern] of cases) {
    const fake = transport(emit);
    await assert.rejects(requestCleanPublicRoute({ ...binding, httpsRequest: fake.httpsRequest }), error => {
      assert.match(error.message, pattern);
      assert.doesNotMatch(error.message, /REMOTE_SECRET/);
      return true;
    });
    assert.equal(fake.requestDestroyed, true);
    assert.equal(fake.responseDestroyed, true);
  }
});

test("OPS-01: total deadline closes a trickling response as well as a stalled TLS handshake", async () => {
  let interval;
  const fake = transport(response => {
    interval = setInterval(() => response.emit("data", Buffer.from("x")), 2);
  });
  try {
    await assert.rejects(requestCleanPublicRoute({ ...binding, timeoutMs: 30,
      httpsRequest: fake.httpsRequest }), /deadline exceeded/);
    assert.equal(fake.requestDestroyed, true);
    assert.equal(fake.responseDestroyed, true);
  } finally { clearInterval(interval); }
  let destroyed = false;
  await assert.rejects(requestCleanPublicRoute({ ...binding, timeoutMs: 10,
    httpsRequest: () => {
      const request = new EventEmitter();
      request.end = () => {};
      request.destroy = () => { destroyed = true; };
      return request;
    } }), /deadline exceeded/);
  assert.equal(destroyed, true);
});

test("OPS-01: transport rejects invalid deadlines before connecting", () => {
  for (const timeoutMs of [0, -1, 8001, Infinity, 1.5, "10"]) {
    assert.throws(() => requestCleanPublicRoute({ ...binding, timeoutMs,
      httpsRequest: () => assert.fail("invalid timeout connected") }), /timeout/);
  }
});

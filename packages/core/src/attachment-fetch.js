import dns from "node:dns/promises";
import https from "node:https";
import net from "node:net";
import { Readable, Transform } from "node:stream";
import { finished } from "node:stream/promises";
import { BridgeError } from "./errors.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function failure(code, message, status = 400) {
  return new BridgeError(code, message, status);
}

function parseIpv4(address) {
  if (net.isIP(address) !== 4) return null;
  const octets = address.split(".").map(Number);
  return octets.reduce((value, octet) => ((value << 8) | octet) >>> 0, 0);
}

function ipv4InRange(value, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (parseIpv4(base) & mask);
}

function isPublicIpv4(address) {
  const value = parseIpv4(address);
  if (value === null) return false;
  const blocked = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ];
  return !blocked.some(([base, prefix]) => ipv4InRange(value, base, prefix));
}

function parseIpv6(address) {
  let value = address.toLowerCase().split("%")[0];
  if (net.isIP(value) !== 6) return null;
  if (value.includes(".")) {
    const split = value.lastIndexOf(":");
    const ipv4 = parseIpv4(value.slice(split + 1));
    if (ipv4 === null) return null;
    value = `${value.slice(0, split)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right].map((word) => Number.parseInt(word || "0", 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : null;
}

function isPublicIpv6(address) {
  const words = parseIpv6(address);
  if (!words) return false;
  const mappedIpv4 = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (mappedIpv4) {
    const ipv4 = `${words[6] >>> 8}.${words[6] & 0xff}.${words[7] >>> 8}.${words[7] & 0xff}`;
    return isPublicIpv4(ipv4);
  }
  const sixToFour = words[0] === 0x2002;
  if (sixToFour) {
    const ipv4 = `${words[1] >>> 8}.${words[1] & 0xff}.${words[2] >>> 8}.${words[2] & 0xff}`;
    return isPublicIpv4(ipv4);
  }
  const globalUnicast = (words[0] & 0xe000) === 0x2000;
  const documentation = words[0] === 0x2001 && words[1] === 0x0db8;
  const teredo = words[0] === 0x2001 && words[1] === 0x0000;
  const orchid = words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0010;
  const orchidV2 = words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0020;
  const documentationV2 = words[0] === 0x3fff && (words[1] & 0xf000) === 0x0000;
  return globalUnicast && !documentation && !documentationV2 && !teredo && !orchid && !orchidV2;
}

export function isPublicAttachmentAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

async function resolveHost(hostname) {
  const literal = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  const family = net.isIP(literal);
  if (family) return [{ address: literal, family }];
  return dns.lookup(literal, { all: true, verbatim: true });
}

function openHttps({ url, address, family, signal, headers }) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "GET",
      headers,
      agent: false,
      signal,
      lookup(_hostname, options, callback) {
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      },
    }, (response) => resolve({
      statusCode: response.statusCode || 0,
      headers: response.headers,
      body: response,
      destroy(error) { response.destroy(error); },
    }));
    request.once("error", reject);
    request.end();
  });
}

class ByteLimit extends Transform {
  constructor(maxBytes, abort) {
    super();
    this.maxBytes = maxBytes;
    this.abort = abort;
    this.bytes = 0;
  }

  _transform(chunk, encoding, callback) {
    this.bytes += Buffer.byteLength(chunk, encoding);
    if (this.bytes > this.maxBytes) {
      const error = failure("attachment_too_large", "Attachment exceeds the configured size limit", 413);
      callback(error);
      this.abort(error);
      return;
    }
    callback(null, chunk);
  }
}

function createAbortScope(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timeout = false;
  const abortFromCaller = () => controller.abort(
    externalSignal.reason || failure("attachment_cancelled", "Attachment transfer was cancelled", 499),
  );
  if (externalSignal?.aborted) abortFromCaller();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timeout = true;
    controller.abort(failure("attachment_timeout", "Attachment transfer exceeded its deadline", 504));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    abort(reason) { if (!controller.signal.aborted) controller.abort(reason); },
    error() {
      if (controller.signal.reason instanceof BridgeError) return controller.signal.reason;
      if (timeout) return failure("attachment_timeout", "Attachment transfer exceeded its deadline", 504);
      return failure("attachment_cancelled", "Attachment transfer was cancelled", 499);
    },
    close() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortFromCaller);
    },
  };
}

function withAbort(promise, scope) {
  if (scope.signal.aborted) return Promise.reject(scope.error());
  return new Promise((resolve, reject) => {
    const aborted = () => reject(scope.error());
    scope.signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve(promise).then(
      (value) => {
        scope.signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        scope.signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}

export class AttachmentFetcher {
  constructor({
    timeoutMs = 120000,
    maxBytes = 64 * 1024 * 1024,
    maxRedirects = 5,
    maxConcurrent = 2,
    resolve = resolveHost,
    open = openHttps,
  } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Attachment timeout must be positive");
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("Attachment size limit must be positive");
    if (!Number.isInteger(maxRedirects) || maxRedirects < 0) throw new Error("Attachment redirect limit is invalid");
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("Attachment concurrency must be positive");
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.maxRedirects = maxRedirects;
    this.maxConcurrent = maxConcurrent;
    this.resolve = resolve;
    this.open = open;
    this.active = 0;
  }

  async fetch(rawUrl, { signal } = {}) {
    if (this.active >= this.maxConcurrent) {
      throw failure("attachment_busy", "Attachment transfer concurrency limit reached", 429);
    }
    this.active += 1;
    const scope = createAbortScope(signal, this.timeoutMs);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      scope.close();
      this.active -= 1;
    };

    try {
      let current = new URL(rawUrl);
      for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
        if (scope.signal.aborted) throw scope.error();
        if (current.protocol !== "https:" || current.username || current.password || (current.port && current.port !== "443")) {
          throw failure("attachment_url_blocked", "Attachment source URL is not allowed");
        }
        const records = await withAbort(
          Promise.resolve().then(() => this.resolve(current.hostname)),
          scope,
        );
        if (!Array.isArray(records) || records.length === 0) {
          throw failure("attachment_dns_failed", "Attachment source could not be resolved", 502);
        }
        if (records.some(({ address }) => !isPublicAttachmentAddress(address))) {
          throw failure("attachment_address_blocked", "Attachment source resolved to a blocked address");
        }
        const selected = records[0];
        let response;
        try {
          response = await this.open({
            url: current,
            address: selected.address,
            family: selected.family,
            signal: scope.signal,
            headers: { accept: "application/octet-stream" },
          });
        } catch (error) {
          if (scope.signal.aborted) throw scope.error();
          throw failure("attachment_fetch_failed", "Attachment source request failed", 502);
        }

        if (REDIRECT_STATUSES.has(response.statusCode)) {
          const location = response.headers.location;
          response.destroy();
          if (!location || redirects === this.maxRedirects) {
            throw failure("attachment_redirect_blocked", "Attachment redirect policy rejected the response", 502);
          }
          current = new URL(location, current);
          continue;
        }
        if (response.statusCode < 200 || response.statusCode >= 300 || !response.body) {
          response.destroy();
          throw failure("attachment_fetch_failed", "Attachment source returned an invalid response", 502);
        }

        const declaredLength = Number.parseInt(response.headers["content-length"] || "", 10);
        if (Number.isFinite(declaredLength) && declaredLength > this.maxBytes) {
          response.destroy();
          throw failure("attachment_too_large", "Attachment exceeds the configured size limit", 413);
        }

        const limited = new ByteLimit(this.maxBytes, (error) => scope.abort(error));
        response.body.pipe(limited);
        const abortBody = () => {
          const error = scope.error();
          response.destroy();
          if (!limited.destroyed) limited.destroy(error);
        };
        scope.signal.addEventListener("abort", abortBody, { once: true });
        finished(limited).then(release, release);

        return {
          body: Readable.toWeb(limited),
          signal: scope.signal,
          dispose() {
            scope.signal.removeEventListener("abort", abortBody);
            response.destroy();
            limited.destroy();
            release();
          },
        };
      }
      throw failure("attachment_redirect_blocked", "Attachment redirect policy rejected the response", 502);
    } catch (error) {
      release();
      if (error instanceof BridgeError) throw error;
      throw failure("attachment_fetch_failed", "Attachment source request failed", 502);
    }
  }
}

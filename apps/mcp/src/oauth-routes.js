import { isOAuthError } from "../../../packages/auth/src/oauth-spike.js";

const FORM_LIMIT = 16 * 1024;

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    pragma: "no-cache",
  });
  response.end(payload);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function readForm(request) {
  const type = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") {
    const error = new Error("Form encoding is required");
    error.name = "OAuthError";
    error.code = "invalid_request";
    error.status = 400;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > FORM_LIMIT) {
      const error = new Error("OAuth form is too large");
      error.name = "OAuthError";
      error.code = "invalid_request";
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

async function readJson(request) {
  const type = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    const error = new Error("JSON encoding is required");
    error.name = "OAuthError"; error.code = "invalid_request"; error.status = 400;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > FORM_LIMIT) {
      const error = new Error("Registration request is too large");
      error.name = "OAuthError"; error.code = "invalid_request"; error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch {
    const error = new Error("Registration JSON is invalid");
    error.name = "OAuthError"; error.code = "invalid_request"; error.status = 400;
    throw error;
  }
}

function executionProfileDisclosure(profile) {
  if (profile === "files-read") {
    return {
      title: "Read-only files",
      summary: "Read-only access permits listing and downloading files only inside configured allowed roots. It cannot modify files or run commands.",
      button: "Authorize read-only access",
      warning: "",
      blocked: false,
    };
  }
  if (profile === "full-shell") {
    return {
      title: "Full shell access",
      summary: "Full shell access permits arbitrary command execution with the configured work-account operating-system rights.",
      button: "Authorize full shell access",
      warning: "Commands may read, create, modify, move, or delete every file accessible to that account; start or stop processes; access credentials available to that account; and cause irreversible data loss. This does not grant root by itself, but any existing sudo or elevation rights of the work account remain effective.",
      blocked: false,
    };
  }
  return {
    title: "Unrecognized execution profile",
    summary: "Authorization is blocked because this server profile has no explicit operating-system rights disclosure.",
    button: "",
    warning: "",
    blocked: true,
  };
}

function approvalPage(transaction) {
  const scopes = transaction.scopes.map(escapeHtml).join(", ");
  const profile = executionProfileDisclosure(transaction.executionProfile);
  const warning = profile.warning
    ? `<p role="alert"><strong>Security warning:</strong> ${escapeHtml(profile.warning)}</p>`
    : "";
  const approval = profile.blocked
    ? `<p role="alert"><strong>Authorization unavailable.</strong> Ask the server owner to configure a recognized execution profile.</p>`
    : `<form method="post" action="/oauth/authorize" autocomplete="off">
      <input type="hidden" name="transaction" value="${escapeHtml(transaction.id)}">
      <label>Staging approval secret <input type="password" name="approval_secret" required minlength="32"></label>
      <button type="submit">${escapeHtml(profile.button)}</button>
    </form>`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DP Beget Bridge authorization</title></head>
<body>
  <main>
    <h1>DP Beget Bridge staging authorization</h1>
    <p>Client: <code>${escapeHtml(transaction.clientId)}</code></p>
    <p>Resource: <code>${escapeHtml(transaction.resource)}</code></p>
    <p>Requested access: <strong>${scopes}</strong></p>
    <p>Execution profile: <strong>${escapeHtml(profile.title)}</strong> (<code>${escapeHtml(transaction.executionProfile)}</code>)</p>
    <p>${escapeHtml(profile.summary)}</p>
    ${warning}
    ${approval}
  </main>
</body>
</html>`;
}

function sendOAuthError(response, error) {
  const status = Number.isInteger(error.status) ? error.status : 400;
  sendJson(response, status, {
    error: isOAuthError(error) ? error.code : "server_error",
    error_description: isOAuthError(error) ? error.message : "Authorization request failed",
  });
}

export async function handleOAuthRoute({ request, response, url, oauth }) {
  if (!oauth) return false;

  try {
    if (request.method === "GET" && oauth.protectedResourceMetadataPaths.has(url.pathname)) {
      sendJson(response, 200, oauth.protectedResourceMetadata());
      return true;
    }
    if (request.method === "GET" && url.pathname === oauth.authorizationMetadataPath) {
      sendJson(response, 200, oauth.authorizationServerMetadata());
      return true;
    }
    if (request.method === "POST" && url.pathname === "/oauth/register") {
      sendJson(response, 201, oauth.registerClient(await readJson(request)));
      return true;
    }
    if (request.method === "GET" && url.pathname === "/oauth/authorize") {
      const transaction = await oauth.beginAuthorization(url.searchParams);
      const body = approvalPage(transaction);
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
        pragma: "no-cache",
        "content-security-policy": "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
      });
      response.end(body);
      return true;
    }
    if (request.method === "POST" && url.pathname === "/oauth/authorize") {
      const form = await readForm(request);
      const redirect = oauth.approve({
        transactionId: form.get("transaction"),
        approvalSecret: form.get("approval_secret"),
      });
      response.writeHead(303, { location: redirect, "cache-control": "no-store", pragma: "no-cache" });
      response.end();
      return true;
    }
    if (request.method === "POST" && url.pathname === "/oauth/token") {
      const form = await readForm(request);
      const token = oauth.exchange(form, { authorizationHeader: request.headers.authorization });
      sendJson(response, 200, token);
      return true;
    }
    if (request.method === "POST" && url.pathname === "/oauth/revoke") {
      const form = await readForm(request);
      oauth.revoke(form);
      response.writeHead(200, { "cache-control": "no-store", pragma: "no-cache" });
      response.end();
      return true;
    }
  } catch (error) {
    sendOAuthError(response, error);
    return true;
  }
  return false;
}

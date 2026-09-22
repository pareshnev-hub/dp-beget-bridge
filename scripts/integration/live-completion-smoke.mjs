import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const baseUrl = (process.env.DP_AGENT_URL || "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.DP_AGENT_TOKEN;
const dataDir = process.env.DP_SESSION_DATA_DIR || "/var/lib/dp-beget-bridge";
const timeoutMs = Number(process.env.DP_COMPLETION_SMOKE_TIMEOUT_MS || 30000);
const preserveOnFailure = process.env.DP_COMPLETION_SMOKE_PRESERVE_ON_FAILURE === "true";

if (!token) throw new Error("DP_AGENT_TOKEN is required");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let sessionId;
let completed = false;

function sessionPath(suffix = "") {
  return `/v1/sessions/${sessionId}${suffix}`;
}

async function request(method, pathname, body = undefined) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw new Error(`Agent request failed (${response.status}): ${text}`);
  return payload;
}

function compactTerminalText(value) {
  return value
    .replace(/A{64,}/g, (match) => `<base64-A-run:${match.length}>`)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (character) => (
      `<0x${character.charCodeAt(0).toString(16).padStart(2, "0")}>`
    ));
}

async function bestEffort(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      code: error.code ?? null,
      stdout: String(error.stdout || "").trim(),
      stderr: String(error.stderr || error.message || "").trim().slice(0, 2000),
    };
  }
}

async function collectDiagnostics(operationId, operation) {
  const sessionDir = path.join(dataDir, "sessions", sessionId);
  const outputPath = path.join(sessionDir, "terminal.log");
  const operationsDir = path.join(sessionDir, "operations");
  let terminal = Buffer.alloc(0);
  try { terminal = await fs.readFile(outputPath); } catch {}
  let completionFiles = [];
  try { completionFiles = (await fs.readdir(operationsDir)).sort(); } catch {}
  const terminalText = terminal.toString("utf8");
  const operationOffset = terminalText.indexOf(operationId);
  const controlOffset = terminalText.indexOf("__dpb_exit");
  const sampleStart = Math.max(0, Math.min(
    operationOffset === -1 ? terminal.length - 4096 : operationOffset - 1024,
    terminal.length - 4096,
  ));
  const terminalSample = compactTerminalText(terminal.subarray(sampleStart, sampleStart + 8192).toString("utf8"));
  const tmuxArgs = process.env.DP_TMUX_SOCKET ? ["-S", process.env.DP_TMUX_SOCKET] : [];
  const tmuxName = `dpb_${sessionId}`;
  const pane = await bestEffort(process.env.DP_TMUX_BIN || "tmux", [
    ...tmuxArgs,
    "list-panes",
    "-t",
    tmuxName,
    "-F",
    "#{pane_pid}|dead=#{pane_dead}|status=#{pane_dead_status}|command=#{pane_current_command}|history=#{history_bytes}|pipe=#{pane_pipe}",
  ]);
  const panePid = pane.ok ? Number.parseInt(pane.stdout.split("|", 1)[0], 10) : null;
  const processes = Number.isSafeInteger(panePid)
    ? await bestEffort("ps", ["-eo", "pid=,ppid=,stat=,wchan=,comm=,args="])
    : { ok: false, code: "pane_pid_unavailable", stdout: "", stderr: "" };
  const relatedProcesses = processes.ok
    ? processes.stdout.split("\n").filter((line) => line.includes(String(panePid))).slice(0, 30)
    : [];
  const journal = await bestEffort("journalctl", [
    "-u",
    "dp-beget-session-host.service",
    "--since",
    "-10 minutes",
    "--no-pager",
    "-o",
    "cat",
  ]);
  const relatedJournal = journal.ok
    ? journal.stdout.split("\n").filter((line) => (
      line.includes(sessionId) || line.includes(operationId)
    )).slice(-100)
    : [];

  return {
    operation,
    terminalBytes: terminal.length,
    controlEcho: {
      operationIdOffset: operationOffset,
      completionAssignmentOffset: controlOffset,
      operationIdPresent: operationOffset !== -1,
      completionAssignmentPresent: controlOffset !== -1,
    },
    completionFiles,
    terminalSampleOffset: sampleStart,
    terminalSample,
    pane,
    relatedProcesses,
    relatedJournal,
    sessionDir,
    preservedOnFailure: preserveOnFailure,
  };
}

async function waitFor(operationId, statuses) {
  const expected = new Set(statuses);
  const deadline = Date.now() + timeoutMs;
  let operation;
  while (Date.now() < deadline) {
    operation = await request("GET", sessionPath(`/operations/${operationId}`));
    if (expected.has(operation.status)) return operation;
    await delay(100);
  }
  const diagnostics = await collectDiagnostics(operationId, operation);
  throw new Error(`Operation timeout with diagnostics:\n${JSON.stringify(diagnostics, null, 2)}`);
}

try {
  const opened = await request("POST", "/v1/sessions", { cwd: ".", label: "DP-007 live smoke" });
  sessionId = opened.id;

  const forged = await request("POST", sessionPath("/commands"), {
    idempotencyKey: `term08-${sessionId}`,
    command: "printf \"__DPB_DONE_forged:0\\n\"; sleep 1; false",
    waitMs: 50,
  });
  assert.equal(forged.status, "RUNNING");
  const forgedFinal = await waitFor(forged.operationId, ["FAILED"]);
  assert.equal(forgedFinal.exitCode, 1);

  const large = await request("POST", sessionPath("/commands"), {
    idempotencyKey: `term09-${sessionId}`,
    command: "head -c 200000 /dev/zero | base64 -w0; false",
    waitMs: 50,
  });
  const largeFinal = await waitFor(large.operationId, ["FAILED"]);
  assert.equal(largeFinal.exitCode, 1);

  await fs.rm(`${dataDir}/sessions/${sessionId}/terminal.log`);
  const retained = await request("GET", sessionPath(`/operations/${large.operationId}`));
  assert.equal(retained.status, "FAILED");
  assert.equal(retained.exitCode, 1);

  const execResult = await request("POST", sessionPath("/commands"), {
    idempotencyKey: `exec-${sessionId}`,
    command: "exec false",
    waitMs: 50,
  });
  const execFinal = await waitFor(execResult.operationId, ["UNKNOWN"]);
  assert.equal(execFinal.exitCode, null);
  assert.equal(execFinal.outcomeReason, "session_lost_during_operation");

  console.log(JSON.stringify({
    result: "pass",
    endpoint: baseUrl,
    scenarios: ["TERM-08", "TERM-09", "transcript-removal", "exec-unknown"],
  }));
  completed = true;
} finally {
  if (sessionId && (completed || !preserveOnFailure)) {
    await request("DELETE", sessionPath()).catch(() => {});
  }
}

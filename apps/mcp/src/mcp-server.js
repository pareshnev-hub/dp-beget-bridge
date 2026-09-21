import crypto from "node:crypto";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mutating = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const destructive = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const shellAccess = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const externalDestructive = { ...destructive, openWorldHint: true };

const openAiFile = z.object({
  download_url: z.string().url(),
  file_id: z.string(),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
}).strict();

const fileEntry = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["directory", "file", "other"]),
  size: z.number().int().nonnegative(),
  modifiedAt: z.string(),
}).strict();

const transferredFile = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function attachmentName(file) {
  const supplied = file.file_name
    ?.replaceAll("\\", "/")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  const safe = supplied ? path.posix.basename(supplied) : "";
  if (safe && safe !== "." && safe !== "..") return safe;
  const identity = crypto.createHash("sha256").update(file.file_id).digest("hex").slice(0, 16);
  return `attachment-${identity}`;
}

export function createBridgeMcpServer({ agent, downloads, config, requestSignal }) {
  const server = new McpServer({ name: "dp-beget-bridge", version: "0.1.0" });

  server.registerTool("get_bridge_status", {
    title: "Get DP Beget Bridge status",
    description: "Check the connected agent, protocol version, and available capabilities.",
    annotations: readOnly,
  }, async () => textResult(await agent.capabilities()));

  server.registerTool("list_terminal_sessions", {
    title: "List persistent terminal sessions",
    description: "List terminal sessions. Sessions survive MCP requests and remain alive until explicitly closed.",
    annotations: readOnly,
  }, async () => textResult(await agent.listSessions()));

  server.registerTool("open_terminal", {
    title: "Open a persistent terminal",
    description: "Open a persistent terminal on the connected server. It remains alive until close_terminal is called.",
    inputSchema: {
      cwd: z.string().optional().describe("Initial directory within an allowed root."),
      label: z.string().max(120).optional().describe("Human-readable session label."),
    },
    annotations: mutating,
  }, async (input) => textResult(await agent.openTerminal(input)));

  server.registerTool("run_terminal_command", {
    title: "Run a terminal command",
    description: "Run a shell command in a persistent terminal. A timeout only stops waiting; it never kills the command or terminal.",
    inputSchema: {
      session_id: z.string(),
      command: z.string().min(1),
      wait_ms: z.number().int().min(0).max(30000).optional(),
      idempotency_key: z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/)
        .describe("Stable key for safe retries of the same command in this session."),
    },
    annotations: shellAccess,
  }, async ({ session_id, command, wait_ms, idempotency_key }) => textResult(
    await agent.runCommand(session_id, {
      command,
      waitMs: wait_ms,
      idempotencyKey: idempotency_key,
    }),
  ));

  server.registerTool("get_terminal_operation", {
    title: "Get terminal operation status",
    description: "Read durable managed-command status without returning command text or a request fingerprint.",
    inputSchema: {
      session_id: z.string(),
      operation_id: z.string(),
    },
    annotations: readOnly,
  }, async ({ session_id, operation_id }) => textResult(
    await agent.getOperation(session_id, operation_id),
  ));

  server.registerTool("read_terminal", {
    title: "Read terminal output",
    description: "Read terminal output from a byte cursor without consuming or losing it.",
    inputSchema: {
      session_id: z.string(),
      cursor: z.number().int().min(0).optional(),
      max_bytes: z.number().int().min(1).max(262144).optional(),
    },
    annotations: readOnly,
  }, async ({ session_id, cursor, max_bytes }) => textResult(
    await agent.readOutput(session_id, cursor, max_bytes),
  ));

  server.registerTool("send_terminal_input", {
    title: "Send interactive terminal input",
    description: "Send text to an interactive program running in a persistent terminal.",
    inputSchema: {
      session_id: z.string(),
      input: z.string(),
      enter: z.boolean().optional().default(true),
    },
    annotations: shellAccess,
  }, async ({ session_id, input, enter }) => textResult(await agent.sendInput(session_id, { input, enter })));

  server.registerTool("interrupt_terminal", {
    title: "Interrupt terminal process",
    description: "Send Ctrl-C to the foreground process while keeping the terminal session alive.",
    inputSchema: { session_id: z.string() },
    annotations: destructive,
  }, async ({ session_id }) => textResult(await agent.interrupt(session_id)));

  server.registerTool("close_terminal", {
    title: "Close persistent terminal",
    description: "Explicitly terminate a persistent terminal session.",
    inputSchema: { session_id: z.string(), keep_output: z.boolean().optional().default(false) },
    annotations: destructive,
  }, async ({ session_id, keep_output }) => textResult(await agent.closeTerminal(session_id, keep_output)));

  server.registerTool("list_files", {
    title: "List server files",
    description: "List files and directories within configured allowed roots.",
    inputSchema: { path: z.string().optional().default(".") },
    outputSchema: { path: z.string(), entries: z.array(fileEntry) },
    annotations: readOnly,
  }, async ({ path: candidate }) => textResult(await agent.listFiles(candidate)));

  server.registerTool("upload_files", {
    title: "Upload files to server",
    description: "Transfer files attached in ChatGPT to the connected server using atomic writes.",
    inputSchema: {
      files: z.array(openAiFile).min(1),
      destination_directory: z.string().default("."),
      overwrite: z.boolean().optional().default(false),
    },
    outputSchema: { uploaded: z.array(transferredFile) },
    annotations: externalDestructive,
    _meta: { "openai/fileParams": ["files"] },
  }, async ({ files, destination_directory, overwrite }, { signal }) => {
    const transferSignal = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
    const uploaded = [];
    for (const file of files) {
      const safeName = attachmentName(file);
      const destination = path.posix.join(destination_directory.replaceAll("\\", "/"), safeName);
      uploaded.push(await agent.uploadFromUrl(file, destination, overwrite, { signal: transferSignal }));
    }
    return textResult({ uploaded });
  });

  server.registerTool("download_file", {
    title: "Download a server file",
    description: "Create a short-lived download link for a file on the connected server.",
    inputSchema: { path: z.string() },
    outputSchema: { uri: z.string().url(), expiresAt: z.string() },
    annotations: readOnly,
  }, async ({ path: candidate }) => {
    const { token, expiresAt } = downloads.issue(candidate);
    const uri = `${config.publicUrl.replace(/\/$/, "")}/download/${token}`;
    return {
      content: [
        { type: "text", text: `Download link expires at ${expiresAt}.` },
        { type: "resource_link", uri, name: path.basename(candidate) || "download", description: "Short-lived DP Beget Bridge download" },
      ],
      structuredContent: { uri, expiresAt },
    };
  });

  server.registerTool("copy_path", {
    title: "Copy a server path",
    description: "Copy a file or directory within configured allowed roots.",
    inputSchema: { source: z.string(), destination: z.string(), overwrite: z.boolean().optional().default(false) },
    outputSchema: { source: z.string(), destination: z.string(), copied: z.boolean() },
    annotations: destructive,
  }, async (input) => textResult(await agent.copyPath(input)));

  server.registerTool("move_path", {
    title: "Move a server path",
    description: "Move or rename a file or directory within configured allowed roots.",
    inputSchema: { source: z.string(), destination: z.string(), overwrite: z.boolean().optional().default(false) },
    outputSchema: {
      source: z.string(),
      destination: z.string(),
      moved: z.boolean(),
      reason: z.literal("same_path").optional(),
    },
    annotations: destructive,
  }, async (input) => textResult(await agent.movePath(input)));

  server.registerTool("delete_path", {
    title: "Delete a server path",
    description: "Delete a file, or a directory only when recursive is explicitly true.",
    inputSchema: { path: z.string(), recursive: z.boolean().optional().default(false) },
    outputSchema: { path: z.string(), deleted: z.boolean() },
    annotations: destructive,
  }, async ({ path: candidate, recursive }) => textResult(await agent.deletePath(candidate, recursive)));

  return server;
}

export const PROTOCOL_VERSION = "1.0";

export const CAPABILITIES = Object.freeze({
  terminal: Object.freeze({
    version: "1.0",
    features: [
      "persistent_sessions",
      "reconnect",
      "output_cursor",
      "versioned_transcript_cursor",
      "retained_closed_sessions",
      "explicit_transcript_purge",
      "interactive_input",
      "explicit_close",
    ],
  }),
  files: Object.freeze({
    version: "1.0",
    features: ["list", "upload", "download", "copy", "move", "delete"],
  }),
});

export function capabilityDocument(agentId) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    agentId,
    product: "DP Beget Bridge",
    capabilities: CAPABILITIES,
  };
}

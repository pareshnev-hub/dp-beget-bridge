# ChatGPT file contract

Status: DP-003 verified contract
Captured: 2026-09-21
Verified with actual ChatGPT: 2026-09-22

## Source and version

The file input descriptor follows the OpenAI Plugins Reference section
“Define file inputs”, captured on 2026-09-21:

<https://developers.openai.com/plugins/reference#define-file-inputs>

The versioned machine-readable fixture is
`test/fixtures/openai-file-input-contract.2026-09-21.json`. It identifies the
target as the ChatGPT plugin host using MCP protocol `2025-06-18` and the
dated public contract snapshot `openai-plugins-reference@2026-09-21`.

OpenAI's public contract does not expose a ChatGPT host build number. The
2026-09-22 developer-mode acceptance therefore records the actual ChatGPT app
calls separately from the immediate MCP peer. Through OpenAI Secure MCP Tunnel,
the local MCP server correctly receives `tunnel-client` version
`0.0.14+0f870e50a973fa820d4c409000059e181e8d242b`; no separate ChatGPT build is
forwarded, and the bridge does not infer or invent one.

The actual ChatGPT app `DP Beget Bridge R0002` accepted the descriptors, called
`list_files`, uploaded a 144-byte attachment with `overwrite=false`, observed it
in the allowed root and called `download_file`. ChatGPT reported the expected
text prefix and matching SHA-256. Exact acceptance details are recorded in
`docs/TUNNEL_ACCEPTANCE.md`.

## Input contract

Each `upload_files.files` item declares exactly the four supported properties:

- required: `download_url`, `file_id`;
- optional: `mime_type`, `file_name`.

Missing `file_name` is valid. The bridge derives a deterministic non-sensitive
fallback name from a SHA-256 digest of `file_id`; it never uses the raw identity
as a filesystem name. Supplied names are reduced to a basename and stripped of
control characters before path-policy validation by the Agent.

Outbound URL validation, redirect handling, address policy, timeouts and size
limits are owned by DP-004. Until that gate is verified, this upload path is not
approved for public exposure.

## Descriptor and result rules

- `_meta["openai/fileParams"]` names the top-level `files` field.
- `upload_files` is destructive because `overwrite=true` can replace data.
- `upload_files` is open-world until DP-004 constrains source fetching.
- `copy_path` is destructive because `overwrite=true` can replace data.
- every file tool returning `structuredContent` declares an `outputSchema` that
  matches its actual result shape.

Contract tests inspect the advertised MCP descriptor, reject missing
`file_id`, exercise the optional metadata path, and validate structured output.

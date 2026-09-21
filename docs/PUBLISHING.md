# Publishing

## Public pages

- Product page: `https://pareshnev.com/dp-beget-bridge`
- Documentation and feedback: under the same product page
- Optional future Catalog MCP: `https://bridge.pareshnev.com/mcp`

The public product name is **DP Beget Bridge**. Working documentation uses
**DP**. The full legal author name appears only in the license, notice,
developer verification, and legally required publication fields.

## Two distribution modes

**Direct mode** is open-source software installed on the user's VPS. The user
adds their own HTTPS MCP URL as a custom connector. Commands and files travel
directly between the OpenAI client and that VPS.

**Catalog mode** is a later optional transport. A catalog listing has a fixed
MCP URL and therefore needs a relay. The relay must not store command text,
terminal output, paths, filenames, or file content.

The Direct release is tested in developer mode before Catalog submission.
Catalog submission additionally requires OAuth, accurate tool annotations, a
privacy policy, support contact, and verified developer identity.

## Independence notice

DP Beget Bridge is an independent open-source project and is not affiliated
with, endorsed by, or sponsored by Beget.

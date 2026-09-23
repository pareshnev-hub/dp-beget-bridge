# R0004 release artifact trust — first implementation slice

Status: **CANDIDATE BUILD/SIGN/VERIFY IMPLEMENTED; INSTALLER ENFORCEMENT PENDING**. This does not install, update, publish, or activate a release.

`scripts/release/verify-artifact.mjs` checks a detached Ed25519 signature over the **exact bytes** of a small JSON manifest, then streams the named archive and checks its signed size and SHA-256 digest. The release manifest format is:

```json
{
  "format": "dp-beget-bridge-release-v1",
  "version": "1.0.0",
  "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "artifact": {
    "name": "dp-beget-bridge-1.0.0.tar.gz",
    "size": 12345,
    "sha256": "<64 lowercase hex characters>"
  }
}
```

The values shown are illustrative. The signature file contains canonical Base64 of the raw 64-byte Ed25519 signature, optionally followed by a newline. The key is an Ed25519 SPKI PEM public key. The verifier never accepts a key from the manifest or an archive and does not follow symlinks for its four inputs.

Build an unsigned candidate from an exact, committed SHA into a **new** directory. The builder reads `package.json` from that commit, uses `git archive`, writes a deterministic gzip stream with zero gzip timestamp, and records the archive size and SHA-256 in `manifest.json`. Uncommitted files and `node_modules` are not included. Reproducibility is tested on the supported CI toolchain; a different Git/zlib toolchain may produce different compressed bytes. Release identity is the recorded digest, not an expectation that all toolchains emit identical bytes.

```bash
node scripts/release/build-artifact.mjs --commit <full-40-character-commit-sha> --output-dir /new/private/candidate-directory
```

The release signer receives a private Ed25519 PKCS#8 PEM key from the operator's separate key custody path. It requires a private regular file (mode `0600`), checks the local candidate bytes against the manifest before signing, and creates a new detached signature file without replacing an existing file. Key generation, key distribution, rotation and CI custody are **not** automated or accepted yet.

```bash
node scripts/release/sign-manifest.mjs --artifact /candidate/dp-beget-bridge-1.0.0.tar.gz --manifest /candidate/manifest.json --private-key /separate/private-key.pem --signature /candidate/manifest.sig
```

Local verification of an independently acquired candidate:

```bash
node scripts/release/verify-artifact.mjs --artifact dp-beget-bridge-1.0.0.tar.gz --manifest manifest.json --signature manifest.sig --trustedKey /path/to/independently-trusted-release-key.pem
```

An independent staging utility copies a verified candidate into a newly created private directory, then verifies the copied bytes again. Source-path substitution between the two checks cannot make unverified staged bytes pass. It performs no archive extraction, execution, service change or migration:

```bash
node scripts/release/stage-verified-artifact.mjs --artifact /candidate/dp-beget-bridge-1.0.0.tar.gz --manifest /candidate/manifest.json --signature /candidate/manifest.sig --trusted-key /separate/pinned-release-key.pem --stage-dir /new/private/stage-directory
```

A separate quarantine extractor verifies the signed archive again, checks the exact compressed bytes it will parse, and admits only the `git archive` release layout with regular files and directories below the versioned root. Symlinks, hardlinks, special entries, traversal, duplicate paths and unsupported tar extensions are rejected before any extraction. The private destination is created only after validation. Compressed input is capped at 64 MiB and expanded tar at 256 MiB; the resulting files are mode `0600` and directories `0700` until a future installer applies its runtime ownership policy.

```bash
node scripts/release/extract-verified-artifact.mjs --artifact /stage/dp-beget-bridge-1.0.0.tar.gz --manifest /stage/manifest.json --signature /stage/manifest.sig --trusted-key /separate/pinned-release-key.pem --output-dir /new/private/extraction-directory
```

**Trust boundary:** the public key must be obtained through a separate authenticated channel and pinned by a future installer; placing an untrusted key beside the archive proves nothing. The future installer must consume **only** the verified staged bytes, preflight migrations and switch versions without destroying live Session Host state. Verification, staging and quarantine extraction never execute archive content or alter the running service.

Next slices: approved release-key custody and rotation policy; pinned-key bootstrap; atomic staged install/update with migration backups, health-gated activation and rollback; clean-host and failed-update integration evidence. OPS-05 is only partially implemented until the installer enforces verification before any execution or mutation and tests rejection of a bad signature/checksum.

The read-only R0004 host preflight is separate from the existing technical-preview installer. It currently supports **Ubuntu 24.04 LTS with a preconfigured HTTPS reverse proxy and a single public A record**. It checks a non-root work identity, an absolute real allowed-root directory, Node 22+, host dependencies, exact DNS→VPS IPv4 mapping and a certificate validated for the hostname using SNI. It does not mutate system configuration or install software:

```bash
node scripts/release/host-preflight.mjs --domain bridge.example.com --expected-ip 1.1.1.1 --work-user dp-preview --allowed-root /srv/dp-preview-workspace
```

The IP and hostname above are examples. A setup wizard must make these prerequisites actionable and choose the supported proxy coexistence path before OPS-01…04 can be accepted. The first-time bootstrap may need a different order for DNS/TLS provisioning; this preflight defines the already-routed profile only.

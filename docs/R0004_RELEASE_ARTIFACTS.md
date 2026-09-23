# R0004 release artifact trust — first implementation slice

Status: **IMPLEMENTED FOR LOCAL VERIFICATION ONLY**. This does not install, update, publish, sign, or activate a release.

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

Local verification of an independently acquired candidate:

```bash
node scripts/release/verify-artifact.mjs --artifact dp-beget-bridge-1.0.0.tar.gz --manifest manifest.json --signature manifest.sig --trustedKey /path/to/independently-trusted-release-key.pem
```

**Trust boundary:** the public key must be obtained through a separate authenticated channel and pinned by a future installer; placing an untrusted key beside the archive proves nothing. The future installer must stage the exact verified bytes in an inaccessible version directory and avoid a verify-then-open path substitution. Verification alone must never execute archive content or alter the running service.

Next slices: approved release-key generation/custody and rotation policy; deterministic archive builder and manifest signer in CI; pinned-key bootstrap; atomic staged install/update with migration backups, health-gated activation and rollback; clean-host and failed-update integration evidence. OPS-05 is only partially implemented until the installer enforces verification before any execution or mutation and tests rejection of a bad signature/checksum.

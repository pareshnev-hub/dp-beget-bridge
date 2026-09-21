# Workspace mutation policy

Status: DP-005 implementation policy  
Policy version: 1  
Date: 2026-09-21

## Security boundary

The Agent mutates entries only below a configured allowed root. A mutation
opens the canonical root and every parent directory with `O_DIRECTORY` and
`O_NOFOLLOW`, verifies the opened directory through `/proc/self/fd`, and keeps
the final parent descriptor open through the commit. A symlink swap before a
parent is opened fails closed; a later rename or symlink swap cannot redirect
the pinned descriptor outside the approved root.

The work identity's OS permissions remain the outer boundary. Path and
`realpath` validation supplement that boundary; they do not replace it.

## Supported operations

- Upload writes a unique mode-0600 temporary file in the pinned destination
  directory and commits it only after streaming succeeds.
- Regular-file copy reads through a pinned, `O_NOFOLLOW` source descriptor and
  copies into a unique temporary file before commit.
- Regular-file move is supported on one filesystem.
- Non-recursive deletion removes a leaf entry through its pinned parent;
  deletion of an empty directory is supported.
- `overwrite=false` commits by an atomic hard-link creation. `EEXIST` is an
  explicit conflict, so a destination created concurrently is never replaced.
- `overwrite=true` uses rename as the final same-filesystem commit and never
  pre-deletes the destination.

Configured roots cannot be mutation sources or destinations. Source and
destination paths with an ancestor/descendant relationship are rejected before
filesystem changes.

## Intentionally unsupported

The following return `unsupported_complex_mutation` rather than falling back
to permissive behavior:

- recursive deletion;
- directory or symlink move;
- recursive, directory or non-regular copy;
- directory replacement.

Cross-device move returns `unsupported_cross_device_move`. Directory sync,
recursive replacement and journaled multi-step transfer belong to R0005.

## Migration and rollback

There is no state or configuration migration. Existing callers must stop
requesting recursive delete and directory copy/move until a later policy
version enables them. Rollback to a version without DP-005 reopens known
TOCTOU/no-replace risks and is therefore not an approved operational fallback;
keep unsafe variants disabled instead.

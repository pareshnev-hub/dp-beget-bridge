# Architecture Decision Records

Status values: Proposed, Accepted, Superseded.

Accepted ADRs define architecture constraints. Implementation may lag behind them; ROADMAP controls release order.

- ADR-001 Direct Mode is primary and autonomous
- ADR-002 Linux VPS is the current platform boundary
- ADR-003 Session and Operation are separate state machines
- ADR-004 Session Host owns persistent terminal lifetime
- ADR-005 Authorization for Direct is local to the user VPS
- ADR-006 Runtime identities and service secrets are separated
- ADR-007 Unsafe file mutations are disabled rather than weakened
- ADR-008 Product telemetry is opt-in and non-blocking
- ADR-009 Catalog is an optional transport over shared capabilities
- ADR-010 Direct transactional metadata uses local embedded state
- ADR-011 Public releases use immutable verified artifacts and rollback
- ADR-012 Scaling decisions are driven by measured workload
- ADR-013 Real-client acceptance may use an outbound-only test tunnel
- ADR-014 DP-013 owner grants are enforced at MCP and Agent (Proposed)

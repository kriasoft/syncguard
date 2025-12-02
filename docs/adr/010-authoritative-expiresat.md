# ADR-010 Authoritative ExpiresAtMs from Mutations

**Status:** Accepted
**Date:** 2025-10
**Tags:** time, consistency, heartbeat

## Problem

Redis acquire/extend Lua scripts returned only success indicators, forcing TypeScript to approximate `expiresAtMs` using client-side calculations (`Date.now() + ttlMs`). This created:

1. **Time authority inconsistency**: Redis uses server time, but expiresAtMs came from client time
2. **Heartbeat scheduling inaccuracy**: Clock skew caused missed windows or wasted extensions

## Decision

All backend mutation operations (acquire, extend) MUST return authoritative `expiresAtMs` computed from the backend's designated time source—no client-side approximation permitted.

- Single source of truth for all timestamps
- Eliminates skew-induced bugs
- Enables reliable auto-extend patterns

## Alternatives (brief)

- Client-side approximation with buffer — still drifts, band-aids the problem
- Separate getExpiry() operation — extra round-trip, doesn't solve race

## Impact

- Positive: Consistent timestamps, accurate heartbeat scheduling, reliable auto-extend
- Negative/Risks: Trivial—8 bytes added to return payload

## Links

- Code/Docs: `docs/specs/interface.md` (Time Authority), backend specs (acquire/extend sections)
- Related ADRs: ADR-012 (backend restatement)

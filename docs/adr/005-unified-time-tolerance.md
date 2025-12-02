# ADR-005 Unified Time Tolerance

**Status:** Accepted
**Date:** 2025-09
**Tags:** time, consistency, cross-backend

## Problem

The original `timeMode` design created inconsistent semantics: `timeMode: "strict"` meant 0ms tolerance on Redis (server-time) but 1000ms on Firestore (client-time minimum safe). This violated predictable cross-backend behavior and created operational risks when switching backends.

## Decision

Remove `timeMode` configuration entirely and use unified 1000ms tolerance across all backends:

- Single `TIME_TOLERANCE_MS` constant in interface.md
- Same configuration produces identical liveness semantics
- Backend switching preserves lock behavior
- No conditional tolerance mapping needed

## Alternatives (brief)

- Keep timeMode with per-backend semantics — confusing, unpredictable behavior
- Zero tolerance for all backends — unrealistic for client-time systems

## Impact

- Positive: Predictable behavior, testing simplicity, operational safety during backend migration
- Negative/Risks: Removes fine-grained control (deemed unnecessary complexity)

## Links

- Code/Docs: `docs/specs/interface.md` (TIME_TOLERANCE_MS), `common/time-predicates.ts`
- Related ADRs: None

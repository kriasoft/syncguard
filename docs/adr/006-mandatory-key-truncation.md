# ADR-006 Mandatory Uniform Key Truncation

**Status:** Accepted
**Date:** 2025-09
**Tags:** keys, consistency, cross-backend

## Problem

Original specs allowed backends to either truncate or throw when prefixed storage keys exceeded limits, creating inconsistent cross-backend behavior. The same user key could produce different outcomes on different backends.

## Decision

Make truncation **mandatory** when `prefix:userKey` exceeds backend storage limits:

- All backends MUST apply standardized hash-truncation via `makeStorageKey()`
- Throw `InvalidArgument` only when truncated form still exceeds absolute limits
- Universal application to main lock keys, reverse index keys, and fence counter keys
- Two-step fence key derivation ensures 1:1 mapping between user keys and fence counters

## Alternatives (brief)

- Allow throw or truncate — unpredictable cross-backend behavior
- Always throw on long keys — poor DX, prevents valid use cases

## Impact

- Positive: Predictable behavior, testable cross-backend, composable applications
- Negative/Risks: Requires common utility implementation across backends

## Links

- Code/Docs: `docs/specs/interface.md` (Storage Key Generation, Fence Key Derivation), `common/crypto.ts`
- Related ADRs: ADR-013 (reverse index storage)

# ADR-013 Store Full Storage Key in Reverse Index

**Status:** Accepted
**Date:** 2025-10
**Tags:** redis, correctness, truncation

## Problem

Redis reverse mapping stored the original user key, but release/extend reconstructed the lock key via `{prefix}:{originalKey}`. When key truncation occurred (per ADR-006), reconstruction produced a different key than the truncated form used during acquire—breaking TOCTOU protection.

## Decision

The reverse index MUST store the full computed storage key (post-truncation), not the original user key. Eliminate key reconstruction entirely.

- Index always returns exactly the key used during acquire
- Works under all conditions—truncated or not
- Removes reconstruction logic from scripts

## Alternatives (brief)

- Fix reconstruction logic — still fragile, future changes risk re-breaking
- Disable truncation for index — doesn't solve mismatch
- Separate truncation for index — complexity explosion

## Impact

- Positive: Eliminates correctness bug, simplifies scripts, testable truncation path
- Negative/Risks: Breaking change for index format (acceptable pre-1.0)

## Links

- Code/Docs: `redis/scripts.ts`, `redis/operations/*.ts`
- Related ADRs: ADR-003 (ownership verification), ADR-006 (key truncation)

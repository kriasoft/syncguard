# ADR-003 Explicit Ownership Re-Verification in Mutations

**Status:** Accepted
**Date:** 2025-09
**Tags:** security, toctou, mutations

## Problem

Backend implementations perform release/extend operations by reverse mapping `lockId → key` then querying/mutating the lock. While the atomic transaction/script pattern already provides TOCTOU protection, explicit ownership verification adds defense-in-depth.

## Decision

ALL backends MUST perform explicit ownership verification after reverse mapping lookup:

```typescript
// After fetching document via reverse mapping
if (data?.lockId !== lockId) {
  return { ok: false, reason: "not-found" };
}
```

This provides:

- **Defense-in-depth**: Additional safety layer with negligible performance cost
- **Cross-backend consistency**: Ensures Redis and Firestore implement identical ownership checking
- **TOCTOU protection**: Guards against edge cases in the atomic resolve→validate→mutate flow
- **Code clarity**: Makes ownership verification explicit rather than implicit

## Alternatives (brief)

- Trust index lookup alone — insufficient defense-in-depth against edge cases
- Transaction-only protection — doesn't make ownership check explicit in code

## Impact

- Positive: Protection against rare but catastrophic wrong-lock mutations; cross-backend consistency
- Negative/Risks: Negligible—single field comparison has no measurable overhead

## Links

- Code/Docs: `redis/scripts.ts`, `firestore/operations/*.ts`, `postgres/operations/*.ts`
- Related ADRs: ADR-013 (index retrieval pattern)

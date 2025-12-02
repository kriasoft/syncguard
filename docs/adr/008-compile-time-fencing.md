# ADR-008 Compile-Time Fencing Contract

**Status:** Accepted
**Date:** 2025-10
**Tags:** typescript, api-design, type-safety

## Problem

The specification claimed "TypeScript knows fence exists" for Redis/Firestore, yet the type system required optional fence fields, forcing runtime assertions (`expectFence`/`hasFence`) even when backends guaranteed fencing support.

## Decision

Parameterize result types by capabilities so fence is **required** when `supportsFencing: true`:

```typescript
type AcquireOk<C extends BackendCapabilities> = {
  ok: true;
  lockId: string;
  expiresAtMs: number;
} & (C["supportsFencing"] extends true ? { fence: Fence } : {});
```

- Direct access to `result.fence` for fencing backends—no assertions needed
- Keep only `hasFence()` for generic code accepting unknown backends

## Alternatives (brief)

- Optional fence everywhere — runtime assertions required, poor DX
- Separate backend types — API complexity, code duplication

## Impact

- Positive: Zero boilerplate, type safety, cleaner API, delivers promised ergonomics
- Negative/Risks: Breaking change—`AcquireResult` becomes generic

## Links

- Code/Docs: `common/types.ts`, `docs/specs/interface.md`
- Related ADRs: None

# Architecture Decision Records

This document contains architectural decisions made during the development of SyncGuard. These records document key design choices, their rationale, and consequences.

## ADR-003: Explicit Ownership Re-Verification in Mutations

**Date**: 2024
**Status**: Accepted
**Context**: Backend implementations perform release/extend operations by reverse mapping `lockId → key` then querying/mutating the lock. While the atomic transaction/script pattern already provides TOCTOU protection, explicit ownership verification adds defense-in-depth.

**Decision**: ALL backends MUST perform explicit ownership verification after reverse mapping lookup:

```typescript
// After fetching document via reverse mapping
if (data?.lockId !== lockId) {
  return { ok: false, reason: "not-found" };
}
```

**Rationale**:

- **Defense-in-depth**: Additional safety layer with negligible performance cost
- **Cross-backend consistency**: Ensures Redis and Firestore implement identical ownership checking
- **TOCTOU protection**: Guards against any edge cases in the atomic resolve→validate→mutate flow
- **Code clarity**: Makes ownership verification explicit rather than implicit in the transaction logic

**Consequences**:

- Backends must implement explicit verification (not just index trust)
- Cross-backend consistency ensures Redis and Firestore handle edge cases identically
- Protection against rare but catastrophic wrong-lock mutations
- Documentation of security-critical decision for future maintainers

## ADR-004-R2: Lexicographic Fence Comparison

**Date**: 2024
**Status**: Supersedes ADR-004-R1
**Context**: ADR-004-R1 claimed fences were "opaque" while mandating specific formatting and shipping comparison helpers. This contradiction increased API surface area and created potential for misuse.

**Decision**: Fence tokens are **fixed-width decimal strings with lexicographic ordering**:

- **Public API**: `export type Fence = string` with explicit comparison rule
- **Format**: 19-digit zero-padded decimal strings (e.g., "0000000000000000001")
- **Comparison**: Direct string comparison (`fenceA > fenceB`) works correctly
- **Backend Contract**: All backends return identical 19-digit zero-padded format
- **Overflow Handling**: Map rare backend limits to `LockError("Internal")` with operational guidance

**Rationale**:

- **Simplest possible API**: One comparison rule instead of helper functions and complex usage patterns
- **Intuitive**: String comparison matches developer expectations for ordered values
- **Eliminates contradictions**: No "opaque" claims while mandating specific formats
- **JSON-safe**: Strings serialize naturally without BigInt precision issues
- **Cross-language compatible**: All languages can compare strings lexicographically
- **Consistent format**: Fixed-width padding ensures reliable ordering across backends

**Consequences**:

- Remove `compareFence()` and `isNewerFence()` from public API
- Update backend specs: require identical 19-digit zero-padded format
- Remove `FenceOverflow` from public API; backends map overflow to `Internal`
- Simplify documentation: one comparison rule replaces complex usage patterns
- Backend implementations remain unchanged (already use consistent formatting)
- Cleanup operations MUST only delete lock data, never fence counters

## ADR-005: Unified Time Tolerance

**Date**: 2024
**Status**: Accepted
**Context**: The original `timeMode` design created inconsistent semantics across backends: `timeMode: "strict"` meant 0ms tolerance on Redis (server-time) but 1000ms tolerance on Firestore (client-time minimum safe). This violated the principle of predictable cross-backend behavior and created operational risks when switching backends.

**Decision**: Remove `timeMode` configuration entirely and use **unified 1000ms tolerance** across all backends:

- **Single tolerance**: `TIME_TOLERANCE_MS = 1000` constant for all backends
- **Consistent behavior**: Same configuration produces identical liveness semantics
- **No modes**: Remove `timeMode` from capabilities and configuration
- **Cross-backend portability**: Backend switching preserves lock behavior

**Rationale**:

- **Eliminates confusion**: "Strict" mode was misleading - didn't mean the same thing across backends
- **Predictable behavior**: Users can reason about lock liveness without backend-specific knowledge
- **Operational safety**: Backend migration doesn't change lock semantics subtly
- **Testing simplicity**: Cross-backend tests work without tolerance adjustments
- **Realistic precision**: 1000ms tolerance is appropriate for distributed locks given network delays and clock skew

**Consequences**:

- Remove `timeMode` from `BackendCapabilities` interface
- Simplify time predicate usage to single `TIME_TOLERANCE_MS` constant
- Update Redis and Firestore specs to remove mode-specific configuration
- Simplify backend implementation - no conditional tolerance mapping
- Cross-backend consistency tests become straightforward
- Documentation focuses on time authority differences, not tolerance modes

## ADR-006: Mandatory Uniform Key Truncation

**Date**: 2024
**Status**: Accepted
**Context**: Original specs allowed backends to either truncate or throw when prefixed storage keys exceeded backend limits, creating inconsistent cross-backend behavior. This made the library unpredictable and difficult to test, as the same user key could produce different outcomes on different backends.

**Decision**: Make truncation **mandatory** when `prefix:userKey` exceeds backend storage limits:

- **Mandatory truncation**: All backends MUST apply standardized hash-truncation when prefixed keys exceed limits
- **Throw only as last resort**: `InvalidArgument` only when even truncated form exceeds absolute backend limits
- **Common implementation**: All backends MUST use identical `makeStorageKey()` helper from common utilities
- **Universal application**: Applies to main lock keys, reverse index keys, and fence counter keys

**Rationale**:

- **Predictable behavior**: Same user key produces same outcome across all backends
- **Testable**: Cross-backend tests work without special-casing backend limits
- **Composable**: Applications can rely on uniform truncation behavior
- **Safe**: Maintains DoS protection while ensuring consistency
- **Simple**: Eliminates "either/or" complexity in backend implementations

**Consequences**:

- Remove "either throw or truncate" language from all backend specs
- Create common `makeStorageKey()` helper used by all backends
- Update backend documentation to reference common implementation
- Simplify cross-backend testing (no need to handle different outcomes)
- Ensure all key types (main, index, fence) use identical truncation logic

## ADR-007: Opt-In Telemetry

**Date**: 2024
**Status**: Accepted
**Context**: Original specification mandated telemetry for all operations, requiring backends to compute hashes and emit events even when no consumer existed. This created unnecessary overhead, complicated the core API with redaction policies, and made testing more difficult due to side effects in every operation.

**Decision**: Make telemetry **opt-in** via a decorator pattern:

- **Telemetry OFF by default**: Backends track cheap internal details but don't compute hashes or emit events
- **Decorator pattern**: `withTelemetry(backend, options)` wraps backends to add observability
- **Simplified lookup**: `lookup()` always returns sanitized data; `lookupDebug()` provides raw access
- **Unified redaction**: Single `includeRaw` option in decorator, no per-call overrides
- **Async isolation**: Event callbacks never block operations or propagate errors

**Rationale**:

- **Zero-cost abstraction**: No performance impact when telemetry disabled
- **Cleaner separation**: Core backends focus on correctness; telemetry is a composable layer
- **Simpler API**: Removes `includeRaw` from core config and per-call parameters
- **Better testing**: Pure functions without side effects by default
- **Tree-shakable**: Applications without telemetry can exclude the decorator entirely

**Consequences**:

- **Breaking change**: `onEvent` in `LockConfig` deprecated; use decorator instead
- **Migration required**: Applications using telemetry must wrap backends
- **New helpers**: Add `withTelemetry()` decorator and `lookupDebug()` function
- **Simplified backends**: Remove hash computation and event emission from core operations
- **Documentation update**: Clearly mark telemetry as optional feature

## ADR-008: Compile-Time Fencing Contract

**Date**: 2025
**Status**: Accepted
**Context**: The specification claimed that with Redis/Firestore "TypeScript knows fence exists," yet the type system required optional fence fields, forcing runtime assertions (`expectFence`/`hasFence`) even when backends guaranteed fencing support. This created unnecessary boilerplate and contradicted the promised ergonomics.

**Decision**: Parameterize result types by capabilities so fence is **required** when `supportsFencing: true`:

- **Type-level guarantee**: `AcquireResult<C>` includes required `fence` when `C['supportsFencing'] extends true`
- **No runtime assertions**: Direct access to `result.fence` for fencing backends
- **Simplified helpers**: Keep only `hasFence()` for generic code accepting unknown backends
- **v1 scope**: All bundled backends (Redis, Firestore) provide fencing; non-fencing backends out of scope

**Implementation**:

```typescript
type AcquireOk<C extends BackendCapabilities> = {
  ok: true;
  lockId: string;
  expiresAtMs: number;
} & (C["supportsFencing"] extends true ? { fence: Fence } : {});

type AcquireResult<C extends BackendCapabilities> =
  | AcquireOk<C>
  | { ok: false; reason: "locked"; retryAfterMs?: number };

interface LockBackend<C extends BackendCapabilities> {
  acquire(opts: KeyOp & { ttlMs: number }): Promise<AcquireResult<C>>;
  // ...
}
```

**Rationale**:

- **Zero boilerplate**: Fencing backends provide fence at compile-time, no assertions needed
- **Type safety**: TypeScript prevents accessing fence on non-fencing backends
- **Cleaner API**: Removes `expectFence()` and `supportsFencing()` helpers from public API
- **Delivers promise**: Matches ergonomic examples in backend documentation
- **Forward compatible**: Capabilities field remains for potential future non-fencing adapters

**Consequences**:

- **Breaking change**: `AcquireResult` becomes generic, parameterized by capabilities
- **Improved DX**: Direct `result.fence` access for Redis/Firestore backends
- **Simplified surface**: Remove two helper functions from public API
- **Documentation update**: Show direct fence access in all examples
- **Migration**: Applications using `expectFence()` can remove it; `hasFence()` remains for generic code

## ADR-009: Retries Live in Helpers, Core Backends are Single-Attempt

**Date**: 2025
**Status**: Accepted
**Context**: Users expect transparent retry on contention, but we want to keep backends minimal and composable. The initial spec included retry configuration in core constants, creating confusion about where retry logic lives.

**Decision**:

- **`lock()` helper handles all retry logic** and is the primary export
- **Backends perform single-attempt operations only** - no retry logic in backends
- **Split constants**: `BACKEND_DEFAULTS` (ttlMs only) from `LOCK_DEFAULTS` (retry config)
- **Default retry strategy**: Exponential backoff with equal jitter (50% randomization)
- **Removed `retryAfterMs`** field - no current backends can provide meaningful hints

**Rationale**:

- **Clear layering**: Backends stay minimal, helpers add smart behavior
- **Predictable API**: Single-attempt semantics at backend level
- **Composable**: Users can build custom retry strategies if needed
- **No dead fields**: Removing `retryAfterMs` simplifies the interface
- **Discoverable**: Making `lock()` primary export guides users to the happy path

**Consequences**:

- **Breaking change**: Remove `retryAfterMs` from `AcquireResult`
- **Smaller core API**: Backends have simpler contract
- **Easier onboarding**: Users discover `lock()` first
- **Clearer responsibilities**: Retry logic centralized in helper
- **Simpler test matrix**: Backend tests don't need retry scenarios
